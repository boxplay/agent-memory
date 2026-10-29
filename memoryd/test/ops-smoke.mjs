#!/usr/bin/env node
// W3 验收：提醒引擎 / launchd dry-run / npm pack 打包 / export-import。
// 全部在临时 root 跑；不写 ~/Library/LaunchAgents、不弹系统通知、不发布 npm。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { resolveConfig } from '../src/config.mjs';
import { makeAppContext } from '../src/http.mjs';
import { createApp } from '../src/http.mjs';
import { overlayPaths } from '../src/overlay.mjs';
import { runRemind, readReminders } from '../src/remind.mjs';
import { exportMemory, importMemory } from '../src/transfer.mjs';
import { planInstall, install, uninstall, status } from '../src/launchd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = path.resolve(HERE, '..', 'bin', 'memoryd.mjs');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const REAL_CARDS = path.join(REPO, 'memory-ingest', 'data', 'cards.jsonl');
const REAL_BUNDLE = path.join(REPO, 'memory-ingest', 'memory', 'bundle.json');
const realBefore = { cards: sha(REAL_CARDS), bundle: sha(REAL_BUNDLE) };

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

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `memoryd-${prefix}-`));
  fs.mkdirSync(path.join(root, 'memory-ingest', 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory-ingest', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory-galaxy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memoryd', 'data'), { recursive: true });
  fs.copyFileSync(REAL_CARDS, path.join(root, 'memory-ingest', 'data', 'cards.jsonl'));
  fs.copyFileSync(REAL_BUNDLE, path.join(root, 'memory-ingest', 'memory', 'bundle.json'));
  fs.copyFileSync(path.join(REPO, 'memory-galaxy', 'index.html'), path.join(root, 'memory-galaxy', 'index.html'));
  const config = resolveConfig({ root, 'max-per-day': '1000', 'max-per-minute': '1000' });
  const store = new Store(config);
  store.load();
  const ctx = makeAppContext(store, config);
  return { root, config, store, ctx };
}
function resetReminders({ config }) {
  const paths = overlayPaths(config);
  const st = JSON.parse(fs.readFileSync(paths.state, 'utf8').replace(/^\uFEFF/, '') || '{}');
  delete st.reminders;
  fs.writeFileSync(paths.state, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.rmSync(path.join(config.outDir, 'reminders'), { recursive: true, force: true });
}

const roots = [];
function cleanup() {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}

try {
  // ================= 提醒引擎 =================
  const A = makeRoot('w3-remind');
  roots.push(A.root);
  {
    const now = new Date('2026-10-29T09:30:00+08:00');
    const r1 = runRemind(A.ctx, { now, notify: false });
    check('R1 扫描出 due_today（买猫粮 10-29）', r1.due === 1 && r1.queued >= 2, JSON.stringify({ due: r1.due, queued: r1.queued }));
    const queued = readReminders(A.config, '2026-10-29');
    check('R1 写队列（digest + due_today）', queued.some((x) => x.kind === 'digest') && queued.some((x) => x.kind === 'due_today'));
    const r2 = runRemind(A.ctx, { now, notify: false });
    check('R1 同卡当天不重复', r2.queued === 0 && readReminders(A.config, '2026-10-29').length === queued.length);

    // 静默时段：只入队不通知
    resetReminders(A);
    const calls = [];
    const fake = (t, b) => (calls.push([t, b]), true);
    const q = runRemind(A.ctx, { now: new Date('2026-10-31T23:30:00+08:00'), notify: true, notifyImpl: fake });
    check('R2 静默时段只入队不通知', q.quiet === true && q.notified === 0 && calls.length === 0 && q.queued > 0);

    // 通知上限：maxNotify=1 → 只通知 1 条（digest 优先）
    resetReminders(A);
    const calls2 = [];
    const fake2 = (t, b) => (calls2.push([t, b]), true);
    const n = runRemind(A.ctx, {
      now: new Date('2026-10-29T10:00:00+08:00'),
      notify: true,
      notifyImpl: fake2,
      dailyNotifyMax: 1
    });
    check('R3 每日通知上限生效', n.notified === 1 && calls2.length === 1 && calls2[0][0] === 'memoryd 今日摘要');

    // 关闭通知：零系统调用
    resetReminders(A);
    const calls3 = [];
    const off = runRemind(A.ctx, {
      now: new Date('2026-10-29T10:00:00+08:00'),
      notify: false,
      notifyImpl: (t, b) => (calls3.push(t), true)
    });
    check('R5 关闭通知时不调用通知器', off.notified === 0 && calls3.length === 0);

    // dry-run 零写入
    resetReminders(A);
    const dry = runRemind(A.ctx, { now: new Date('2026-10-29T10:00:00+08:00'), dryRun: true });
    check('R dry-run 零写入', dry.dryRun === true && readReminders(A.config, '2026-10-29').length === 0);
  }

  // /reminders API
  {
    runRemind(A.ctx, { now: new Date('2026-10-29T10:00:00+08:00'), notify: false });
    const app = createApp(A.ctx, A.config);
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    const res = await fetch(base + '/reminders?date=2026-10-29');
    const json = await res.json();
    check('R4 GET /reminders 返回队列', res.status === 200 && json.data.items.length > 0 && json.data.counts.due_today >= 1);
    app.close();
  }

  // MCP memory_reminders
  {
    const child = spawn(process.execPath, [BIN, 'mcp', '--root', A.root], { stdio: ['pipe', 'pipe', 'ignore'] });
    const rl = (await import('node:readline')).createInterface({ input: child.stdout });
    const pending = new Map();
    let seq = 0;
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    });
    const request = (method, params) => {
      const id = ++seq;
      const p = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error('timeout'))), 8000);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return p;
    };
    try {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ops', version: '0' } });
      const list = await request('tools/list', {});
      check('MCP 工具含 memory_reminders（7 个）', (list.result?.tools || []).some((t) => t.name === 'memory_reminders') && list.result.tools.length === 7);
      const call = await request('tools/call', { name: 'memory_reminders', arguments: { date: '2026-10-29' } });
      const text = call.result?.content?.map((c) => c.text).join('') || '';
      check('MCP memory_reminders 返回提醒', !call.result?.isError && text.includes('提醒'));
    } finally {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
    }
  }

  // ================= launchd dry-run =================
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryd-home-'));
    roots.push(home);
    const plan = planInstall(A.config, { home });
    check('L1 plist 含绝对 node 与入口', plan.plist.includes(process.execPath) && plan.plist.includes('memoryd.mjs'));
    check('L1 plist 可解析结构（Label/KeepAlive/RunAtLoad）',
      plan.plist.includes('com.du.memoryd') && plan.plist.includes('<key>KeepAlive</key>') && plan.plist.includes('<key>RunAtLoad</key>'));
    const dry = install(A.config, { home });
    check('L1 install 默认 dry-run 不写文件', dry.dryRun === true && dry.wrote === false && !fs.existsSync(plan.plistPath));
    const st = status(A.config, { home });
    check('L4 status 无 plist 时如实报告', st.plistExists === false && st.launchctlState === 'not-loaded');
    const un = uninstall(A.config, { home, yes: true });
    check('L3 uninstall 幂等（无文件也不报错）', un.removed === false);
  }

  // ================= npm pack =================
  {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: path.join(REPO, 'memoryd'), encoding: 'utf8' });
    check('P1 npm pack --dry-run 可执行', pack.status === 0, (pack.stderr || '').slice(0, 120));
    let files = [];
    try {
      files = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
    } catch {}
    check('P1 包内只有 bin/src/README/package.json',
      files.length > 0 && files.every((f) => f === 'package.json' || f === 'README.md' || f.startsWith('bin/') || f.startsWith('src/')),
      files.filter((f) => !(f === 'package.json' || f === 'README.md' || f.startsWith('bin/') || f.startsWith('src/'))).join(','));
    check('P1 包内不含 data/ 与 REPORT', !files.some((f) => f.startsWith('data/') || f.startsWith('REPORT')));

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryd-pack-'));
    roots.push(dest);
    const made = spawnSync('npm', ['pack', '--pack-destination', dest], { cwd: path.join(REPO, 'memoryd'), encoding: 'utf8' });
    check('P2 npm pack 成功', made.status === 0);
    const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
    check('P2 产物存在', Boolean(tgz));
    if (tgz) {
      const ex = spawnSync('tar', ['-xzf', path.join(dest, tgz), '-C', dest]);
      check('P2 解包成功', ex.status === 0);
      const pkgDir = path.join(dest, 'package');
      const v = spawnSync(process.execPath, [path.join(pkgDir, 'bin', 'memoryd.mjs'), 'version'], { encoding: 'utf8' });
      check('P2 解包后 version 可运行', v.status === 0 && v.stdout.includes('memoryd 0.1.0'), (v.stderr || '').slice(0, 120));
      const d = spawnSync(process.execPath, [path.join(pkgDir, 'bin', 'memoryd.mjs'), 'doctor', '--root', A.root], { encoding: 'utf8' });
      check('P2 解包后 doctor --root 可运行', d.status === 0 && d.stdout.includes('cards='), (d.stderr || '').slice(0, 120));
      // 包内密钥扫描
      // 只扫代码文件；README 合法提到 ~/.config/memory-ingest/env（说明"不读密钥"），不算泄漏
      const bad = [];
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const f = path.join(dir, name);
          if (fs.statSync(f).isDirectory()) walk(f);
          else {
            const text = fs.readFileSync(f, 'utf8');
            if (/sk-[A-Za-z0-9_-]{20,}|DEEPSEEK=/.test(text)) bad.push(path.relative(dest, f));
          }
        }
      };
      walk(path.join(pkgDir, 'bin'));
      walk(path.join(pkgDir, 'src'));
      check('P3 包内无密钥引用', bad.length === 0, bad.join(','));
    }
  }

  // ================= export / import =================
  const A2 = makeRoot('w3-export');
  roots.push(A2.root);
  {
    // 造数据：2 条 note（一条随后撤销）+ consolidate + pin 基座卡
    // 直接走 ctx.inbox 避免起服务
    const n1 = A2.ctx.inbox.accept({ kind: 'fact', text: '导出测试 EXPORT-111 唯一词', source: { agent: 'export-agent' } });
    const n2 = A2.ctx.inbox.accept({ kind: 'commitment', text: '导出测试 EXPORT-222 下周三前发报告', source: { agent: 'export-agent' } });
    const cons = spawnSync(process.execPath, [BIN, 'consolidate', '--root', A2.root], { encoding: 'utf8' });
    check('E0 准备数据 consolidate 成功', cons.status === 0, (cons.stderr || '').slice(0, 120));
    A2.ctx.overlay.reload();
    A2.ctx.overlay.reload();
    // 撤销 EXPORT-222 的 note
    const pathsA = overlayPaths(A2.config);
    fs.appendFileSync(
      pathsA.feedback,
      JSON.stringify({
        feedback_id: 'fb_test_undo_1',
        action: 'undo',
        target: n2.note_id,
        target_type: 'note',
        agent: 'test',
        at: new Date().toISOString(),
        reason: 'test'
      }) + '\n'
    );
    A2.ctx.overlay.reload();
    const baseShaA = sha(path.join(A2.root, 'memory-ingest', 'data', 'cards.jsonl'));

    const expFile = path.join(A2.config.outDir, 'export-test.jsonl');
    const exp = exportMemory(A2.ctx, { out: expFile, includeBase: true });
    check('E1 导出计数正确', exp.counts.baseCards === 622 && exp.counts.notes >= 2 && exp.counts.agentCards >= 1 && exp.counts.feedback >= 1, JSON.stringify(exp.counts));
    const st = fs.statSync(expFile);
    check('E1 导出文件 600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
    check('E1 导出前后基座未变', baseShaA === sha(path.join(A2.root, 'memory-ingest', 'data', 'cards.jsonl')));

    const expNoBase = path.join(A2.config.outDir, 'export-nobase.jsonl');
    exportMemory(A2.ctx, { out: expNoBase, includeBase: false });
    const noBaseLines = fs.readFileSync(expNoBase, 'utf8').split('\n').filter(Boolean);
    check('E6 --no-base 不含 baseCard', !noBaseLines.some((l) => l.includes('"type":"baseCard"')));

    // 导入到新 root
    const B = makeRoot('w3-import');
    roots.push(B.root);
    const baseShaB = sha(path.join(B.root, 'memory-ingest', 'data', 'cards.jsonl'));
    const dry = importMemory(B.ctx, { file: expFile, dryRun: true });
    check('E5 dry-run 零写入', dry.dryRun === true && !fs.existsSync(overlayPaths(B.config).agentCards));
    const imp = importMemory(B.ctx, { file: expFile, dryRun: false });
    check('E2 导入计数', imp.plan.notes >= 2 && imp.plan.agentCards >= 1 && imp.plan.feedback >= 1, JSON.stringify(imp.plan));
    B.ctx.overlay.reload();
    const snapB = B.ctx.overlay.get();
    check('E2 导入后 notes/agentCards 落盘', snapB.notes.length >= 2 && snapB.agentCards.length >= 1);
    check('E4 导入前后目标基座未变', baseShaB === sha(path.join(B.root, 'memory-ingest', 'data', 'cards.jsonl')));

    const again = importMemory(B.ctx, { file: expFile, dryRun: false });
    check('E3 重复导入幂等（全部 skip）',
      again.plan.notes === 0 && again.plan.agentCards === 0 && again.plan.feedback === 0 && again.plan.skippedNotes >= 2);

    // 坏文件 / schema 不符
    const badFile = path.join(B.config.outDir, 'bad.jsonl');
    fs.writeFileSync(badFile, 'not json\n', { mode: 0o600 });
    let badThrown = false;
    try {
      importMemory(B.ctx, { file: badFile, dryRun: true });
    } catch {
      badThrown = true;
    }
    check('E5 坏文件报错', badThrown);
    const schemaFile = path.join(B.config.outDir, 'schema.jsonl');
    fs.writeFileSync(schemaFile, JSON.stringify({ type: 'meta', schema: 999, version: 'x', exportedAt: '', includeBase: false, counts: {}, baseSha256: '' }) + '\n', { mode: 0o600 });
    badThrown = false;
    try {
      importMemory(B.ctx, { file: schemaFile, dryRun: true });
    } catch {
      badThrown = true;
    }
    check('E5 schema 版本不符报错', badThrown);

    // 导出前凭据拦截
    const pathsA2 = overlayPaths(A2.config);
    fs.appendFileSync(
      pathsA2.agentCards,
      JSON.stringify({
        id: 'ac_leaktest',
        type: 'fact',
        cat: 'work',
        cat_source: 'test',
        text: '泄漏测试 sk-abcdefghijklmnopqrstuvwxyz1234567890AB',
        quote: '',
        created_at: new Date().toISOString(),
        day: '2026-10-29',
        occurred_at: '2026-10-29',
        due_at: null,
        status: null,
        confidence: 0.6,
        topics: [],
        entities: [],
        source: { kind: 'agent', agent: 'test', note_id: 'n_leak' }
      }) + '\n'
    );
    let leakThrown = false;
    try {
      exportMemory(A2.ctx, { out: path.join(A2.config.outDir, 'should-not-exist.jsonl'), includeBase: false });
    } catch {
      leakThrown = true;
    }
    check('E1 导出前凭据拦截', leakThrown);
  }

  check('真实基座未被改动', realBefore.cards === sha(REAL_CARDS) && realBefore.bundle === sha(REAL_BUNDLE));
} catch (err) {
  fail++;
  console.log(`FAIL 异常：${err.message}`);
  console.log(err.stack);
} finally {
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
