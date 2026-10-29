#!/usr/bin/env node
// MCP stdio 冒烟：以真实子进程方式握手、列工具、调 4 个读工具 + 2 个写工具。
// 写工具在临时 root 上跑，不污染真实 overlay 与基座数据。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { estTokens } from '../src/context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = path.resolve(HERE, '..', 'bin', 'memoryd.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryd-mcp-'));
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'data'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'memory'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'memory-ingest', 'data', 'cards.jsonl'), path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'));
fs.copyFileSync(path.join(REPO, 'memory-ingest', 'memory', 'bundle.json'), path.join(tmp, 'memory-ingest', 'memory', 'bundle.json'));
const baseCardId = JSON.parse(fs.readFileSync(path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'), 'utf8').split('\n').filter(Boolean)[0]).id;

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const child = spawn(process.execPath, [BIN, 'mcp', '--root', tmp], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let seq = 0;
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function request(method, params) {
  const id = ++seq;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 8000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return promise;
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const toolText = (res) => res?.result?.content?.map((c) => c.text).join('\n') || '';

try {
  // 1) initialize
  const init = await request('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'memoryd-smoke', version: '0.0.0' }
  });
  check('initialize 回 legacy 版本 2025-06-18', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);
  check('initialize 声明 tools 能力', Boolean(init.result?.capabilities?.tools));
  check('initialize serverInfo', init.result?.serverInfo?.name === 'memoryd');
  check('initialize 带 instructions', typeof init.result?.instructions === 'string' && init.result.instructions.length > 10);
  notify('notifications/initialized');

  // 2) ping
  const ping = await request('ping', {});
  check('ping 返回 {}', ping.result && Object.keys(ping.result).length === 0);

  // 3) tools/list（4 读 + 2 写）
  const list = await request('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check(
    'tools/list 含 7 个工具（5 读 + 2 写）',
    names.join(',') === 'memory_context,memory_feedback,memory_note,memory_profile,memory_recall,memory_reminders,memory_today',
    names.join(',')
  );
  check('每个工具都有 description + inputSchema', (list.result?.tools || []).every((t) => t.description && t.inputSchema?.type === 'object'));

  // 4) 读工具
  const recallRes = await request('tools/call', {
    name: 'memory_recall',
    arguments: { q: '我在可视化上有什么偏好？', k: 3 }
  });
  const recallText = toolText(recallRes);
  check('memory_recall 有结果且非错误', !recallRes.result?.isError && recallText.includes('条'), recallText.slice(0, 60));

  const todayRes = await request('tools/call', { name: 'memory_today', arguments: {} });
  check('memory_today 返回今天摘要', !todayRes.result?.isError && toolText(todayRes).includes('今天'));

  const profileRes = await request('tools/call', { name: 'memory_profile', arguments: {} });
  const profileText = toolText(profileRes);
  check('memory_profile 包含人设与统计', !profileRes.result?.isError && profileText.includes('人设') && profileText.includes('统计'));

  const contextRes = await request('tools/call', {
    name: 'memory_context',
    arguments: { q: '偏好', budget: 2000 }
  });
  const contextText = toolText(contextRes);
  check(
    'memory_context 段落齐全且 ≤2000',
    !contextRes.result?.isError && contextText.includes('## 人设') && contextText.length <= 2000 &&
      estTokens(contextText) <= 2000,
    `chars=${contextText.length} est=${estTokens(contextText)}`
  );

  // 5) 写工具（临时 root）
  const note1 = await request('tools/call', {
    name: 'memory_note',
    arguments: { kind: 'fact', text: 'MCP 写入测试 ZETA-4242 唯一词', idempotency_key: 'mcp-note-1' }
  });
  check('memory_note 写入成功', !note1.result?.isError && toolText(note1).includes('已记下'), toolText(note1).slice(0, 60));
  const note2 = await request('tools/call', {
    name: 'memory_note',
    arguments: { kind: 'fact', text: 'MCP 写入测试 ZETA-4242 唯一词', idempotency_key: 'mcp-note-1' }
  });
  check('memory_note 幂等去重', !note2.result?.isError && toolText(note2).includes('已存在'), toolText(note2).slice(0, 60));

  const inboxFiles = fs.existsSync(path.join(tmp, 'memoryd', 'data', 'inbox'))
    ? fs.readdirSync(path.join(tmp, 'memoryd', 'data', 'inbox'))
    : [];
  const inboxText = inboxFiles.map((n) => fs.readFileSync(path.join(tmp, 'memoryd', 'data', 'inbox', n), 'utf8')).join('\n');
  check('memory_note 落盘到 temp inbox', inboxText.includes('ZETA-4242'));

  const notYet = await request('tools/call', { name: 'memory_recall', arguments: { q: 'ZETA-4242' } });
  check('写入后未整理前不可见（异步设计）', toolText(notYet).includes('未找到'), toolText(notYet).slice(0, 60));

  const rem = await request('tools/call', { name: 'memory_reminders', arguments: {} });
  check('memory_reminders 有返回（无队列也会说明）', !rem.result?.isError && toolText(rem).includes('提醒'));

  const fb = await request('tools/call', {
    name: 'memory_feedback',
    arguments: { action: 'done', target: baseCardId }
  });
  check('memory_feedback done 成功', !fb.result?.isError && toolText(fb).includes('已执行 done'), toolText(fb).slice(0, 60));

  const fbBad = await request('tools/call', {
    name: 'memory_feedback',
    arguments: { action: 'forget', target: 'c_does_not_exist' }
  });
  check('memory_feedback 目标不存在 → isError', fbBad.result?.isError === true);

  // 6) 错误路径
  const unknownTool = await request('tools/call', { name: 'memory_nope', arguments: {} });
  check('未知工具 → isError', unknownTool.result?.isError === true);

  const badDate = await request('tools/call', { name: 'memory_recall', arguments: { from: '20261022' } });
  check('非法 from → isError（不崩溃）', badDate.result?.isError === true);

  const unknownMethod = await request('resources/list', {});
  check('未知方法 → -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));
} catch (err) {
  fail++;
  console.log(`FAIL 异常：${err.message}`);
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const cardsHint = /\] .{2,}（id /.test(stderr);
check('stderr 日志不含卡片正文', !cardsHint);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
