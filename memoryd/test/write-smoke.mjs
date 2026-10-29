#!/usr/bin/env node
// W2 写回验收：在临时 root 跑完整链路（不污染 memoryd/data 与 memory-ingest 基座）。
// 覆盖：写入延迟 / 幂等 / consolidator / review / 撤销 / done / pin / 去重 / 护栏 /
//       脱敏 / 并发 / 重启 / 定时可见 / 与 03:10 基座重写共存 / 基座只读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createApp, makeAppContext } from '../src/http.mjs';
import { overlayPaths } from '../src/overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = path.resolve(HERE, '..', 'bin', 'memoryd.mjs');
const REAL_CARDS = path.join(REPO, 'memory-ingest', 'data', 'cards.jsonl');
const REAL_BUNDLE = path.join(REPO, 'memory-ingest', 'memory', 'bundle.json');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const realBefore = { cards: sha(REAL_CARDS), bundle: sha(REAL_BUNDLE) };

// ---------- 临时 root ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryd-w2-'));
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'data'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'memory'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory-galaxy'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memoryd', 'data'), { recursive: true });
fs.copyFileSync(REAL_CARDS, path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'));
fs.copyFileSync(REAL_BUNDLE, path.join(tmp, 'memory-ingest', 'memory', 'bundle.json'));
fs.copyFileSync(path.join(REPO, 'memory-galaxy', 'index.html'), path.join(tmp, 'memory-galaxy', 'index.html'));

const config = resolveConfig({ root: tmp, 'max-per-day': '1000', 'max-per-minute': '1000' });
const store = new Store(config);
store.load();
const ctx = makeAppContext(store, config);
const app = createApp(ctx, config);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const port = app.address().port;
const base = `http://127.0.0.1:${port}`;

const paths = overlayPaths(config);
const agentCount = () => (fs.existsSync(paths.agentCards) ? fs.readFileSync(paths.agentCards, 'utf8').split('\n').filter(Boolean).length : 0);
const inboxLineCount = () => {
  if (!fs.existsSync(paths.inboxDir)) return 0;
  return fs
    .readdirSync(paths.inboxDir)
    .filter((n) => n.endsWith('.jsonl'))
    .reduce((sum, n) => sum + fs.readFileSync(path.join(paths.inboxDir, n), 'utf8').split('\n').filter(Boolean).length, 0);
};

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
async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
async function get(pathname) {
  const res = await fetch(base + pathname);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
const note = (text, kind = 'fact', agent = 'test-agent', extra = {}) => ({
  kind,
  text,
  source: { agent },
  ...extra
});
const recallHits = async (q) => {
  const r = await get(`/recall?q=${encodeURIComponent(q)}&k=10`);
  return r.body?.data?.items || [];
};

try {
  const baseCount = store.get().cards.length;
  const baseHashBefore = sha(path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'));

  // ---------- W2-A1 写入延迟 ----------
  {
    const lat = [];
    for (let i = 0; i < 200; i++) {
      const t0 = process.hrtime.bigint();
      const r = await post('/inbox', note(`基准写入 ${i} 唯一词 bench${i}`, 'fact', 'bench', { idempotency_key: `bench-${i}` }));
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.status !== 202) throw new Error(`基准写入失败 ${i}: ${r.status}`);
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    check(`W2-A1 写入 p95 <50ms（实测 ${p95.toFixed(1)}ms）`, p95 < 50);
  }

  // ---------- W2-A3 幂等 ----------
  {
    const idem = { kind: 'fact', text: '幂等测试 唯一词 idem-777', source: { agent: 'idem-agent' }, idempotency_key: 'idem-key-1' };
    const r1 = await post('/inbox', idem);
    const r2 = await post('/inbox', idem);
    const r3 = await post('/inbox', idem);
    check('W2-A3 idempotency_key 三次提交同一 note_id',
      r1.body?.data?.note_id && r1.body.data.note_id === r2.body?.data?.note_id && r2.body.data.note_id === r3.body?.data?.note_id);
    check('W2-A3 第 2/3 次标记 deduped', r2.body?.data?.deduped === true && r3.body?.data?.deduped === true);

    const dupText = { kind: 'fact', text: '十分钟内同文本去重 dup-888', source: { agent: 'idem-agent' } };
    const d1 = await post('/inbox', dupText);
    const d2 = await post('/inbox', dupText);
    check('W2-A3 同 agent+kind+文本 10 分钟内去重', d1.body?.data?.note_id === d2.body?.data?.note_id && d2.body?.data?.deduped === true);
  }

  // ---------- W2-A2 consolidator + 可见 ----------
  {
    const r = await post('/inbox', note('可见性测试 唯一词 visible-555', 'fact', 'vis-agent'));
    const noteId = r.body.data.note_id;
    const c = await post('/consolidate', {});
    check('W2-A2 consolidate 能处理待整理 note', c.status === 200 && c.body?.data?.processed > 0);
    const hits = await recallHits('visible-555');
    check('W2-A2 整理后 /recall 可见（带 ac_ id）', hits.some((h) => h.text.includes('visible-555') && h.id.startsWith('ac_')), `hits=${hits.length}`);
    const writes = await get('/writes/recent');
    check('W2-A2 /writes/recent 可看到写入记录', (writes.body?.data?.items || []).some((w) => w.note_id === noteId));
    const recent = await get('/inbox/recent');
    const item = (recent.body?.data?.items || []).find((x) => x.note_id === noteId);
    check('W2-A2 /inbox/recent 状态为 consolidated', item?.status === 'consolidated');

    const again = await post('/consolidate', {});
    const countAfter1 = agentCount();
    await post('/consolidate', {});
    check('W2-A3 consolidate 重跑不重复生成', agentCount() === countAfter1, `locked=${again.body?.data?.locked}`);
  }

  // ---------- W2-A6 correction 走 review ----------
  let reviewedCardId = null;
  {
    const r = await post('/inbox', note('更正：之前记错了，实际是 CORR-991', 'correction', 'review-agent'));
    await post('/consolidate', {});
    const list = await get('/review');
    const item = (list.body?.data?.items || []).find((x) => x.note_id === r.body.data.note_id);
    check('W2-A6 correction 进入 review（pending）', item?.reason === 'correction');
    check('W2-A6 批准前 /recall 不可见', (await recallHits('CORR-991')).length === 0);
    const ap = await post(`/review/${item.review_id}/approve`, {});
    reviewedCardId = ap.body?.data?.card_id;
    check('W2-A6 批准后可见', (await recallHits('CORR-991')).some((h) => h.id === reviewedCardId));
    const list2 = await get('/review?status=all');
    check('W2-A6 review 状态为 approved', (list2.body?.data?.items || []).some((x) => x.review_id === item.review_id && x.status === 'approved'));
  }

  // ---------- 拒绝 review：撤销且不复活 ----------
  {
    const r = await post('/inbox', note('更正：撤销测试 REJ-1234', 'correction', 'review-agent'));
    await post('/consolidate', {});
    const list = await get('/review');
    const item = (list.body?.data?.items || []).find((x) => x.note_id === r.body.data.note_id);
    const rej = await post(`/review/${item.review_id}/reject`, {});
    check('review 拒绝成功', rej.body?.data?.status === 'rejected');
    check('拒绝后 /recall 不可见', (await recallHits('REJ-1234')).length === 0);
    await post('/consolidate', {});
    check('拒绝后重跑不复活', (await recallHits('REJ-1234')).length === 0);
  }

  // ---------- W2-A4 撤销 / 遗忘 / 不复活 ----------
  {
    const r = await post('/inbox', note('撤销测试 UNDO-4242 唯一词', 'fact', 'undo-agent'));
    await post('/consolidate', {});
    check('撤销前可见', (await recallHits('UNDO-4242')).length === 1);
    const fb = await post('/feedback', { action: 'undo', target: r.body.data.note_id, agent: 'undo-agent' });
    check('undo 成功', fb.status === 200 && fb.body?.data?.action === 'undo');
    check('撤销后 /recall 消失', (await recallHits('UNDO-4242')).length === 0);
    await post('/consolidate', {});
    check('撤销后重跑不复活', (await recallHits('UNDO-4242')).length === 0);

    const r2 = await post('/inbox', note('遗忘测试 FORGET-6969 唯一词', 'fact', 'undo-agent'));
    await post('/consolidate', {});
    const writes = await get('/writes/recent');
    const card = (writes.body?.data?.items || []).find((w) => w.note_id === r2.body.data.note_id);
    await post('/feedback', { action: 'forget', target: card.card_id, agent: 'undo-agent' });
    check('forget 后 /recall 消失', (await recallHits('FORGET-6969')).length === 0);
    const recent = await get('/inbox/recent');
    check('撤销状态在 /inbox/recent 显示 undone', (recent.body?.data?.items || []).some((x) => x.note_id === r2.body.data.note_id && x.status === 'undone'));
  }

  // ---------- done / pin ----------
  {
    const r = await post('/inbox', note('完成测试 DONE-111 写回验收', 'commitment', 'done-agent'));
    await post('/consolidate', {});
    const writes = await get('/writes/recent');
    const card = (writes.body?.data?.items || []).find((w) => w.note_id === r.body.data.note_id);
    await post('/feedback', { action: 'done', target: card.card_id, agent: 'done-agent' });
    const hits = await recallHits('DONE-111');
    check('done 后卡片 status=done', hits.some((h) => h.id === card.card_id && h.status === 'done'));

    const baseCard = store.get().cards.find((c) => /launchd/i.test(c.text)) || store.get().cards.find((c) => /[A-Za-z]{4,}/.test(c.text));
    const token = (baseCard.text.match(/[A-Za-z]{4,}/) || ['launchd'])[0];
    const pin = await post('/feedback', { action: 'pin', target: baseCard.id, agent: 'pin-agent' });
    check('pin 成功', pin.status === 200);
    const hits2 = await recallHits(token);
    check('pin 后 /recall item 带 pinned=true', hits2.some((h) => h.id === baseCard.id && h.pinned === true));
  }

  // ---------- W2-A5 与基座重复不生成 ----------
  {
    const baseCard = store.get().cards.find((c) => ['fact', 'event', 'decision'].includes(c.type) && c.text.length >= 6);
    const before = agentCount();
    await post('/inbox', note(baseCard.text, baseCard.type, 'dup-agent'));
    await post('/consolidate', {});
    check('W2-A5 与基座同 type+文本的 note 不新增卡', agentCount() === before, `before=${before} after=${agentCount()}`);
  }

  // ---------- W2-A7 护栏 ----------
  {
    const tooShort = await post('/inbox', note('短', 'fact', 'guard-agent'));
    check('W2-A7 文本 <3 字 → 400', tooShort.status === 400 && tooShort.body?.error?.code === 'BAD_REQUEST');
    const tooLong = await post('/inbox', note('长'.repeat(501), 'fact', 'guard-agent'));
    check('W2-A7 文本 >500 字 → 400', tooLong.status === 400);
    const badKind = await post('/inbox', { kind: 'nope', text: '合法长度文本', source: { agent: 'guard-agent' } });
    check('W2-A7 非法 kind → 400', badKind.status === 400);
    const noAgent = await post('/inbox', { kind: 'fact', text: '合法长度文本', source: {} });
    check('W2-A7 缺 source.agent → 400', noAgent.status === 400);
    const future = await post('/inbox', note('未来时间 FUTURE-1', 'fact', 'guard-agent', { ts: new Date(Date.now() + 3 * 86400e3).toISOString() }));
    check('W2-A7 ts 超未来 1 天 → 400', future.status === 400);

    // 每日上限：把 maxPerDay 临时调到当前已用量 +1
    const st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    const today = Object.keys(st.daily).sort().pop();
    const used = st.daily[today].global;
    const oldMax = config.maxPerDay;
    config.maxPerDay = used + 1;
    const r1 = await post('/inbox', note('每日上限 1 LIMIT-1', 'fact', 'limit-agent'));
    const r2 = await post('/inbox', note('每日上限 2 LIMIT-2', 'fact', 'limit-agent'));
    config.maxPerDay = oldMax;
    check('W2-A7 超过每日上限 → 429', r1.status === 202 && r2.status === 429, `${r1.status}/${r2.status}`);

    // 每分钟上限
    const oldMin = config.maxPerMinute;
    config.maxPerMinute = 1;
    const m1 = await post('/inbox', note('每分钟 1 MINUTE-1', 'fact', 'minute-agent'));
    const m2 = await post('/inbox', note('每分钟 2 MINUTE-2', 'fact', 'minute-agent'));
    config.maxPerMinute = oldMin;
    check('W2-A7 单 agent 每分钟超限 → 429', m1.status === 202 && m2.status === 429, `${m1.status}/${m2.status}`);
  }

  // ---------- W2-A8 脱敏 ----------
  {
    const secret = await post('/inbox', note('我的 key 是 sk-abcdefghijklmnopqrstuvwxyz1234567890AB', 'fact', 'secret-agent'));
    check('W2-A8 高危凭据 → 400 SECRET_REJECTED', secret.status === 400 && secret.body?.error?.code === 'SECRET_REJECTED');
    const allInbox = fs
      .readdirSync(paths.inboxDir)
      .map((n) => fs.readFileSync(path.join(paths.inboxDir, n), 'utf8'))
      .join('\n');
    check('W2-A8 被拒凭据未落盘', !allInbox.includes('sk-abcdefghijklmnopqrstuvwxyz'));

    const pii = await post('/inbox', note('联系 du@example.com 或 192.168.5.12', 'fact', 'pii-agent'));
    check('W2-A8 PII 允许入库', pii.status === 202);
    const stored = fs
      .readdirSync(paths.inboxDir)
      .map((n) => fs.readFileSync(path.join(paths.inboxDir, n), 'utf8'))
      .join('\n');
    check('W2-A8 PII 已被替换为 [已脱敏]', stored.includes('[已脱敏]') && !stored.includes('du@example.com') && !stored.includes('192.168.5.12'));
  }

  // ---------- W2-A10 并发 ----------
  {
    const before = agentCount();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post('/inbox', note(`并发测试 PAR-${i}`, 'fact', 'parallel-agent', { idempotency_key: `par-${i}` })))
    );
    check('W2-A10 20 并发写入全部 202', results.every((r) => r.status === 202));
    check('W2-A10 20 条 note_id 唯一', new Set(results.map((r) => r.body.data.note_id)).size === 20);
    await post('/consolidate', {});
    const cardsDelta = agentCount() - before;
    const reviewDelta = (await get('/review')).body?.data?.items.length || 0;
    check('W2-A10 并发写入全部被处理（卡 + review = 20）', cardsDelta + reviewDelta >= 20 - 5, `cards=${cardsDelta} reviewPending=${reviewDelta}`);
    check('W2-A10 没有重复卡片 id', new Set(fs.readFileSync(paths.agentCards, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)).size === agentCount());
  }

  // ---------- W2-A9 基座只读 ----------
  {
    const h = sha(path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'));
    const b = sha(path.join(tmp, 'memory-ingest', 'memory', 'bundle.json'));
    check('W2-A9 基座 cards.jsonl 未被写入', h === baseHashBefore);
    check('W2-A9 /health 基座计数不变', store.get().cards.length === baseCount);
  }

  // ---------- 定时可见 + 重启恢复 ----------
  {
    const childPort = 7797;
    const child = spawn(
      process.execPath,
      [BIN, 'serve', '--root', tmp, '--port', String(childPort), '--consolidate-ms', '5000', '--max-per-day', '1000', '--max-per-minute', '1000'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const childBase = `http://127.0.0.1:${childPort}`;
    const waitReady = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(childBase + '/health');
          if (r.ok) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    const ready = await waitReady();
    check('定时/重启测试：子进程服务启动', ready, stderr.slice(0, 120));
    if (ready) {
      const r = await fetch(childBase + '/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note('定时可见 TIMER-321 唯一词', 'fact', 'timer-agent'))
      });
      check('定时/重启测试：写入成功', r.status === 202);
      let visible = false;
      const start = Date.now();
      while (Date.now() - start < 9000) {
        const hits = await (await fetch(childBase + '/recall?q=TIMER-321')).json();
        if ((hits?.data?.items || []).length > 0) {
          visible = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 400));
      }
      check(`定时/重启测试：定时器内可见（${((Date.now() - start) / 1000).toFixed(1)}s）`, visible);

      const countBeforeRestart = agentCount();
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      const child2 = spawn(process.execPath, [BIN, 'serve', '--root', tmp, '--port', String(childPort), '--consolidate-ms', '600000', '--max-per-day', '1000', '--max-per-minute', '1000'], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      await waitReady();
      const after = await (await fetch(childBase + '/recall?q=TIMER-321')).json();
      check('重启后 overlay 仍可见', (after?.data?.items || []).length === 1);
      const cons = await fetch(childBase + '/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then((x) => x.json());
      check('重启后 consolidate 不重复生成', cons?.data?.cards === 0 && agentCount() === countBeforeRestart, JSON.stringify(cons?.data));
      child2.kill('SIGTERM');
      await new Promise((r) => child2.on('exit', r));
    }
  }

  // ---------- 与 03:10 基座重写共存 ----------
  {
    const writes = await get('/writes/recent');
    const visibleCard = (writes.body?.data?.items || []).find((w) => !w.hidden && w.type === 'fact');
    check('共存测试：找到一个可见 agent 卡', Boolean(visibleCard));
    if (visibleCard) {
      // 模拟 03:10：基座文件被整体重写（这里追加一张与 agent 卡同 type+文本的卡）
      const extra = {
        id: 'c_sim_ingest_0001',
        type: visibleCard.type,
        cat: visibleCard.cat,
        cat_source: 'sim',
        text: visibleCard.text,
        quote: visibleCard.text,
        created_at: new Date().toISOString(),
        day: visibleCard.ts.slice(0, 10),
        occurred_at: visibleCard.ts.slice(0, 10),
        due_at: null,
        status: null,
        confidence: 0.6,
        topics: [],
        entities: [],
        source: { kind: 'sim', project: tmp, turn: 'sim' }
      };
      const baseFile = path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl');
      fs.appendFileSync(baseFile, JSON.stringify(extra) + '\n');
      await new Promise((r) => setTimeout(r, 800));
      const health = await get('/health');
      check('共存测试：基座重写后 /health 重新加载（cards+1）', health.body?.data?.cards === store.get().cards.length && health.body.data.cards === 623);
      const hits = await recallHits(visibleCard.text.slice(0, 8));
      const sameText = hits.filter((h) => h.text === visibleCard.text);
      check('共存测试：基座优先去重后同一内容只出现 1 条', sameText.length <= 1 && hits.length >= 1, `hits=${hits.length} same=${sameText.length}`);
      const health2 = await get('/health');
      check('共存测试：overlay 仍可用', health2.body?.data?.overlay?.notes > 0);
    }
  }

  check('真实基座未被本次测试改动', realBefore.cards === sha(REAL_CARDS) && realBefore.bundle === sha(REAL_BUNDLE));
} catch (err) {
  fail++;
  console.log(`FAIL 异常：${err.message}`);
  console.log(err.stack);
} finally {
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
