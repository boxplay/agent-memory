#!/usr/bin/env node
// 接口冒烟：真实数据 + 只读断言（不打印任何卡片正文）。
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createApp, makeAppContext } from '../src/http.mjs';
import { resolveConfig } from '../src/config.mjs';
import { parseDateQuery, addDays, localDate } from '../src/query.mjs';
import { buildContext, estTokens } from '../src/context.mjs';
import { buildMergedBundle } from '../src/graph.mjs';

const config = resolveConfig({});
const store = new Store(config);
store.load();
const state = store.get();

const before = hashFiles([store.paths.cards, store.paths.bundle]);
const ctx = makeAppContext(store, config);
const app = createApp(ctx, config);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const port = app.address().port;
const base = `http://127.0.0.1:${port}`;

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

async function get(pathname) {
  const res = await fetch(base + pathname);
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

function rawRequest(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------- /health ----------
{
  const r = await get('/health');
  const cardsOnDisk = fs.readFileSync(store.paths.cards, 'utf8').split('\n').filter(Boolean).length;
  check('/health 200 + ok', r.status === 200 && r.body?.ok === true);
  check('/health cards 与 cards.jsonl 行数一致', r.body?.data?.cards === cardsOnDisk, `${r.body?.data?.cards} vs ${cardsOnDisk}`);
  check('/health commitments 与索引一致',
    r.body?.data?.commitments?.pending === state.commitments.pending &&
    r.body?.data?.commitments?.total === state.commitments.total);
  check('/health days.withCards > 0', r.body?.data?.days?.withCards > 0);
  check('/health lastError null', r.body?.data?.lastError === null);
}

// ---------- /today ----------
{
  const date = '2026-10-29';
  const r = await get(`/today?date=${date}&limit=20`);
  const d = r.body?.data;
  check('/today 200', r.status === 200 && r.body?.ok === true);
  check('/today date 回显', d?.date === date);
  check('/today due 全是当天 pending',
    (d?.due || []).every((x) => x.due_at === date && x.status === 'pending'));
  check('/today overdue 全早于当天',
    (d?.overdue || []).every((x) => x.due_at < date));
  check('/today counts 与数组一致',
    d?.counts?.due === (d?.due || []).length && d?.counts?.overdue === (d?.overdue || []).length,
    JSON.stringify(d?.counts));
  check('/today highlights <= limit', (d?.highlights || []).length <= 20);
  for (const badDate of ['2026/10/29', '2026-13-01', '2026-02-30']) {
    const bad = await get(`/today?date=${badDate}`);
    check(`/today 非法 date → 400（${badDate}）`, bad.status === 400 && bad.body?.error?.code === 'BAD_REQUEST');
  }
}

// ---------- /profile ----------
{
  const r = await get('/profile');
  const d = r.body?.data;
  check('/profile 200', r.status === 200 && r.body?.ok === true);
  check('/profile persona 非空', Boolean(d?.persona?.content));
  check('/profile profiles 与 bundle 一致', (d?.profiles || []).length === (state.bundle.profiles || []).length);
  check('/profile topics/entities 与索引一致',
    (d?.topics || []).length === state.topics.length && (d?.entities || []).length === state.entities.length);
  check('/profile stats.cards 一致', d?.stats?.cards === state.cards.length);
}

// ---------- /recall ----------
{
  const q = '我在可视化上有什么偏好？';
  const r = await get(`/recall?q=${encodeURIComponent(q)}&k=5`);
  const d = r.body?.data;
  check('/recall 200', r.status === 200 && r.body?.ok === true);
  check('/recall 意图→preference + 主题可视化',
    d?.understood?.type === 'preference' && (d?.understood?.topics || []).includes('可视化'));
  check('/recall 有结果且类型/主题正确',
    (d?.items || []).length > 0 &&
      d.items.every((it) => it.type === 'preference' && it.topics.includes('可视化')));
  check('/recall total >= items', d?.total >= (d?.items || []).length);

  const day = state.days.list[0];
  const r2 = await get(`/recall?from=${day}&to=${day}&k=50`);
  check(`/recall 日期过滤（${day}）全部命中当天`,
    (r2.body?.data?.items || []).length > 0 && r2.body.data.items.every((it) => it.day === day));

  for (const badFrom of ['20261022', '2026-02-30', '2026-13-01']) {
    const r3 = await get(`/recall?from=${badFrom}`);
    check(`/recall 非法 from → 400（${badFrom}）`, r3.status === 400 && r3.body?.error?.code === 'BAD_REQUEST');
  }

  // 无关问题不能拿"只命中一个常见词"的卡片冒充结果；加空格也不能绕过
  for (const q of ['量子计算芯片流片结果', '火星移民计划', '量子计算 芯片 流片', '火星氧气 循环']) {
    const r4 = await get(`/recall?q=${encodeURIComponent(q)}&k=5`);
    check(`/recall 无关问题返回空（${q}）`, r4.status === 200 && r4.body?.data?.total === 0, `total=${r4.body?.data?.total}`);
  }
  const relevant = await get('/recall?q=' + encodeURIComponent('MOSS 音色') + '&k=5');
  check('/recall 相关关键词仍有结果', relevant.body?.data?.total > 0);
}

// ---------- /context ----------
{
  for (const q of ['偏好', '体检', '记忆管理']) {
    const r = await get(`/context?q=${encodeURIComponent(q)}&budget=2000`);
    const d = r.body?.data;
    check(`/context（${q}）chars<=2000 且 estTokens<=2000`,
      d && d.chars <= 2000 && d.estTokens <= 2000 && d.estTokens === estTokens(d.text),
      d ? `chars=${d.chars} est=${d.estTokens}` : 'no data');
  }
  // 小预算把相关记忆裁光时，不能谎报"无匹配记忆"
  const tiny = await get(`/context?q=${encodeURIComponent('可视化')}&budget=200`);
  const tinyData = tiny.body?.data;
  check(
    '/context 小预算命中但被裁剪时如实说明',
    tinyData && tinyData.chars <= 200 && tinyData.hits > 0 &&
      tinyData.text.includes('省略') && !tinyData.text.includes('（无匹配记忆）'),
    tinyData ? `hits=${tinyData.hits} chars=${tinyData.chars}` : 'no data'
  );
}

// ---------- /graph ----------
{
  const r = await fetch(base + '/graph');
  const text = await r.text();
  const actual = JSON.parse(text);
  const view = ctx.view.get();
  // 契约：无 agent 卡且无卡片级写回时与 bundle.json 一致；否则为合并 bundle（含 overlay 的 done/pin/forget 效果）
  const expected = (view.viewMeta?.cardFeedback || 0) > 0
    ? buildMergedBundle(view)
    : JSON.parse(fs.readFileSync(store.paths.bundle, 'utf8'));
  const strip = (b) => { const { generatedAt, ...rest } = b; return JSON.stringify(rest); };
  check('/graph 200 + 与预期 bundle 一致（基座/合并）', r.status === 200 && strip(actual) === strip(expected));
  const etag = r.headers.get('etag');
  const r2 = await fetch(base + '/graph', { headers: { 'If-None-Match': etag } });
  check('/graph ETag 304', r2.status === 304);
}

// ---------- 只读 / 安全 ----------
{
  const post = await fetch(base + '/recall', { method: 'POST' });
  check('POST → 405', post.status === 405 && post.headers.get('allow')?.includes('GET'));

  const hostCode = await rawRequest({ Host: 'evil.example' });
  check('非白名单 Host → 403', hostCode === 403, String(hostCode));

  const ui = await fetch(base + '/');
  const html = await ui.text();
  check('/ 静态页 200 + 引用 data.js',
    ui.status === 200 && (ui.headers.get('content-type') || '').includes('text/html') && html.includes('data.js'));

  const trav = await fetch(base + '/%2e%2e/memory-ingest/data/cards.jsonl');
  const travText = await trav.text();
  check('路径穿越被拒且不泄数据', trav.status !== 200 && !travText.includes('"due_at"'), String(trav.status));
}

// ---------- 纯函数：日期解析 ----------
{
  const now = Date.UTC(2026, 9, 29, 4, 0, 0); // 本地 2026-10-29 12:00
  const today = localDate(new Date(now));
  const cases = [
    ['今天', today, today],
    ['昨天', addDays(today, -1), addDays(today, -1)],
    ['前天', addDays(today, -2), addDays(today, -2)],
    ['2026-10-27', '2026-10-27', '2026-10-27'],
    ['10 月 27 日', `${today.slice(0, 4)}-10-27`, `${today.slice(0, 4)}-10-27`],
    ['最近7天', addDays(today, -6), today]
  ];
  for (const [q, from, to] of cases) {
    const got = parseDateQuery(q, now);
    check(`日期解析「${q}」`, got?.from === from && got?.to === to, JSON.stringify(got));
  }
  check('addDays 跨月', addDays('2026-10-31', 1) === '2026-11-01');
}

// ---------- 只读：数据文件未被改动 ----------
const after = hashFiles([store.paths.cards, store.paths.bundle]);
check('数据文件 sha256 未变（只读）', before === after);

// ---------- 注入器小样 ----------
{
  const built = buildContext(state, { q: '偏好', budget: 2000 });
  check('build_context 段落齐全', built.sections.map((s) => s.name).join(',') === '人设,画像,今天,相关记忆');
  check('build_context 小预算不越界',
    buildContext(state, { q: '偏好', budget: 200 }).chars <= 200);
}

app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

function hashFiles(files) {
  return files
    .map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))
    .join(':');
}
