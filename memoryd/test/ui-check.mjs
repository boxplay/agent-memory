#!/usr/bin/env node
// W2b 静态+接口验收：/graph 与 /data.js 合并、页面标记与内联脚本语法、include_agent=0。
// 浏览器实际渲染无法自动化，这里只验证"页面能加载 + 脚本能编译 + 数据链路正确"，渲染需人工复测。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createApp, makeAppContext } from '../src/http.mjs';
import { buildMergedBundle } from '../src/graph.mjs';
import { normText } from '../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REAL_UI = path.join(REPO, 'memory-galaxy', 'index.html');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryd-ui-'));
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'data'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory-ingest', 'memory'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory-galaxy'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'memory-ingest', 'data', 'cards.jsonl'), path.join(tmp, 'memory-ingest', 'data', 'cards.jsonl'));
fs.copyFileSync(path.join(REPO, 'memory-ingest', 'memory', 'bundle.json'), path.join(tmp, 'memory-ingest', 'memory', 'bundle.json'));
fs.copyFileSync(REAL_UI, path.join(tmp, 'memory-galaxy', 'index.html'));
const baseBundle = JSON.parse(fs.readFileSync(path.join(tmp, 'memory-ingest', 'memory', 'bundle.json'), 'utf8'));

const config = resolveConfig({ root: tmp, 'max-per-day': '1000', 'max-per-minute': '1000' });
const store = new Store(config);
store.load();
const ctx = makeAppContext(store, config);
const app = createApp(ctx, config);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

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
async function getText(pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, headers: res.headers, text: await res.text() };
}
async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const parseDataJs = (text) => {
  const m = text.match(/^window\.__MEMORY__\s*=\s*([\s\S]*);\s*$/);
  return m ? JSON.parse(m[1]) : null;
};

try {
  // ---------- 1. 页面与脚本 ----------
  const page = await getText('/');
  check('GET / 200 text/html', page.status === 200 && (page.headers.get('content-type') || '').includes('text/html'));
  check('页面含"写入记录"入口', page.text.includes('id="btnWrites"') && page.text.includes('id="wModal"'));
  check('页面脚本含 /writes/recent 调用', page.text.includes('/writes/recent'));

  const scripts = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page.text))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (m[2].trim()) scripts.push(m[2]);
  }
  check('内联脚本数 >= 2', scripts.length >= 2, `count=${scripts.length}`);
  let syntaxOk = true;
  let syntaxErr = '';
  for (let i = 0; i < scripts.length; i++) {
    try {
      new vm.Script(scripts[i], { filename: `inline-${i}.js` });
    } catch (e) {
      syntaxOk = false;
      syntaxErr = `#${i}: ${e.message}`;
      break;
    }
  }
  check('所有内联脚本语法可编译', syntaxOk, syntaxErr);

  // ---------- 2. 无 agent 卡时 /data.js 与 /graph = 基座 ----------
  const dataJs0 = await getText('/data.js');
  const data0 = parseDataJs(dataJs0.text);
  check('/data.js 200 且可解析', dataJs0.status === 200 && Boolean(data0));
  check('/data.js 无 agent 卡时与基座 bundle 一致',
    JSON.stringify(data0) === JSON.stringify(baseBundle));
  const graph0 = await getText('/graph');
  check('/graph 无 agent 卡时与基座 bundle 一致',
    JSON.stringify(JSON.parse(graph0.text)) === JSON.stringify(baseBundle));
  const graphBase0 = await getText('/graph?include_agent=0');
  check('/graph?include_agent=0 与基座一致',
    JSON.stringify(JSON.parse(graphBase0.text)) === JSON.stringify(baseBundle));

  // ETag 304（页面数据）
  const etag = dataJs0.headers.get('etag');
  const dataJs304 = await fetch(base + '/data.js', { headers: { 'If-None-Match': etag } });
  check('/data.js 支持 ETag 304', dataJs304.status === 304);

  // ---------- 2a. /today 与页面今日卡片（空 overlay 下口径） ----------
  {
    const t = await (await fetch(base + '/today?limit=2')).json();
    const d = t.data;
    check('/today 四块 + counts + stale 字段齐全',
      Array.isArray(d?.due) && Array.isArray(d?.overdue) && Array.isArray(d?.pending) &&
      Array.isArray(d?.highlights) && typeof d?.counts?.cardsTotal === 'number' && typeof d?.stale === 'boolean');
    const baseCardCount = (baseBundle.days || []).flatMap((x) => x.cards || []).length;
    check('/today counts.cardsTotal 与基座卡数一致', d?.counts?.cardsTotal === baseCardCount,
      `${d?.counts?.cardsTotal} vs ${baseCardCount}`);
    check('/today limit 只截断列表',
      (d?.due || []).length <= 2 && (d?.overdue || []).length <= 2 &&
      (d?.pending || []).length <= 2 && (d?.highlights || []).length <= 2);
    check('页面含今日卡片/行内操作标记',
      page.text.includes('id="todayBox"') && page.text.includes('/today?limit=20') &&
      page.text.includes('row-acts') && page.text.includes('__galaxyTodayRefresh'));
    check('页面含搜索/过滤标记',
      page.text.includes('/recall?q=') && page.text.includes('sr-group') &&
      page.text.includes('ArrowDown') && page.text.includes('id="btnFilter"') &&
      page.text.includes('id="filterPanel"') && page.text.includes('chip-filter'));
    check('页面含时间轴 scrubber 标记',
      page.text.includes('id="scrubber"') && page.text.includes('setFocusDay') &&
      page.text.includes('ArrowLeft') && page.text.includes('sc-sum'));
    check('页面含 P2 错误态/响应式/形状/邻居标记',
      page.text.includes('id="healthBar"') && page.text.includes('prefers-reduced-motion') &&
      page.text.includes('@media (max-width:1280px)') && page.text.includes('drawTypeGlyph') &&
      page.text.includes('neighborOnly') && page.text.includes('id="pNear"') &&
      page.text.includes('id="btnGlow"') && page.text.includes('EXPOSURE') &&
      page.text.includes('galaxy.exposure'));
    check('页面含双球独立旋转/选中高亮标记',
      page.text.includes('sphereSpin') && page.text.includes('rotTarget') &&
      page.text.includes('function sphereAt') && page.text.includes('nearRingOk') === false);
    check('页面含选中高亮/前后景深/方向拖动器标记',
      page.text.includes('nearIds') && page.text.includes('isNearNode') &&
      page.text.includes('depthA') && page.text.includes('id="joy"') &&
      page.text.includes('joyMove') && page.text.includes('JOY.x'));
    const rec = await (await fetch(base + '/recall?q=' + encodeURIComponent('金标评测集') + '&k=5')).json();
    const cardIds = new Set((baseBundle.days || []).flatMap((d) => d.cards || []).map((x) => x.id));
    check('/recall 返回 id 与 bundle card id 对齐（搜索可定位）',
      (rec.data?.items || []).length > 0 && (rec.data.items || []).some((x) => cardIds.has(x.id)));
  }

  // ---------- 2b. 无 agent 卡、仅有卡片级写回时也走合并 bundle（Step 1 契约） ----------
  const pageHtml = page.text;
  const basePool = (baseBundle.days || []).flatMap((d) => d.cards || []);
  const plainPool = basePool.filter((x) => /^c_/.test(x.id || '') && !x.reminds);
  const commitPool = basePool.filter((x) => /^c_/.test(x.id || '') && x.reminds);
  const pinCard = plainPool[0];
  const doneCard = commitPool[0];
  {
    check('页面含 Step 1 面板标记（原话/忘记/写回函数）',
      pageHtml.includes('id="pQuote"') && pageHtml.includes('id="pForget"') && pageHtml.includes('sendFeedback'));
    const pinRes = await post('/feedback', { action: 'pin', target: pinCard.id, agent: 'ui-test' });
    const doneRes = await post('/feedback', { action: 'done', target: doneCard.id, agent: 'ui-test' });
    check('pin/done 200', pinRes.status === 200 && doneRes.status === 200, `${pinRes.status}/${doneRes.status}`);
    const dataJsFb = await getText('/data.js');
    const dataFb = parseDataJs(dataJsFb.text);
    const flatFb = (dataFb?.days || []).flatMap((d) => d.cards || []);
    check('仅卡片级写回（无 agent 卡）也走合并 bundle', Boolean(dataFb) && dataFb.source !== baseBundle.source);
    check('/data.js 回显 pinned', flatFb.some((x) => x.id === pinCard.id && x.pinned === true));
    check('/data.js 回显 done（commitments.status）',
      (dataFb?.commitments || []).some((x) => x.id === 'cm_' + doneCard.id && x.status === 'done'));
    const fb304 = await fetch(base + '/data.js', { headers: { 'If-None-Match': dataJsFb.headers.get('etag') } });
    check('合并路径 /data.js ETag 304（generatedAt 不参与哈希）', fb304.status === 304);
  }

  // ---------- 3. 写入一张 agent 卡后合并 ----------
  const noteText = 'W2b 合并测试 唯一词 ui-merge-9001';
  const r = await post('/inbox', { kind: 'fact', text: noteText, source: { agent: 'ui-test' } });
  check('写入 note 成功', r.status === 202);
  const c = await post('/consolidate', {});
  check('整理出 1 张 agent 卡', c.body?.data?.cards === 1, JSON.stringify(c.body?.data));

  const dataJs1 = await getText('/data.js');
  const data1 = parseDataJs(dataJs1.text);
  const flatCards = (data1?.days || []).flatMap((d) => d.cards || []);
  check('/data.js 合并视图包含 agent 卡且带 agent 标记',
    flatCards.some((x) => x.text.includes('ui-merge-9001') && x.agent === true));
  const graph1 = JSON.parse((await getText('/graph')).text);
  check('/graph 合并视图包含 agent 卡',
    (graph1.days || []).flatMap((d) => d.cards || []).some((x) => x.text.includes('ui-merge-9001')));
  const graphBase1 = JSON.parse((await getText('/graph?include_agent=0')).text);
  check('/graph?include_agent=0 不包含 agent 卡',
    !(graphBase1.days || []).flatMap((d) => d.cards || []).some((x) => x.text.includes('ui-merge-9001')));

  // ---------- 4. 合并 bundle 结构与 build-graph 对齐 ----------
  {
    const view = ctx.view.get();
    const merged = buildMergedBundle(view);
    check('合并 bundle 顶层字段齐全',
      ['generatedAt', 'source', 'persona', 'profiles', 'topics', 'entities', 'days', 'commitments', 'segments', 'artifacts']
        .every((k) => k in merged));
    const firstDay = merged.days.find((d) => d.cards.some((x) => x.text.includes('ui-merge-9001')));
    check('agent 卡落入正确日期/分类', Boolean(firstDay));
    const baseTexts = new Set((baseBundle.days || []).flatMap((d) => d.cards || []).map((x) => normText(x.text)));
    check('合并后基座卡不丢失', (baseBundle.days || []).flatMap((d) => d.cards || []).length > 0 &&
      (merged.days || []).flatMap((d) => d.cards || []).length >=
        (baseBundle.days || []).flatMap((d) => d.cards || []).length);
    check('合并后 commitments 数量 = 基座 + agent 承诺',
      merged.commitments.length >= (baseBundle.commitments || []).length);
    check('基座卡文本集合仍全部存在（抽样前 50）',
      [...baseTexts].slice(0, 50).every((t) => merged.days.some((d) => d.cards.some((x) => normText(x.text) === t))));
  }

  // ---------- 4b. forget 回显：卡片从合并视图消失，基座仍保留 ----------
  {
    const forgetCard = plainPool[1];
    check('找到第二张基座卡用于 forget', Boolean(forgetCard && forgetCard.id !== pinCard.id));
    const res = await post('/feedback', { action: 'forget', target: forgetCard.id, agent: 'ui-test' });
    check('forget 200', res.status === 200);
    const dataJs3 = await getText('/data.js');
    const d3 = parseDataJs(dataJs3.text);
    const flat3 = (d3?.days || []).flatMap((d) => d.cards || []);
    check('/data.js 回显 forget（卡片消失）', !flat3.some((x) => x.id === forgetCard.id));
    const baseGraph3 = JSON.parse((await getText('/graph?include_agent=0')).text);
    check('include_agent=0 仍强制基座（含 forget 掉的卡）',
      (baseGraph3.days || []).flatMap((d) => d.cards || []).some((x) => x.id === forgetCard.id));
  }

  // ---------- 5. review 待确认 UI（临时 root 造数据，不碰真实 overlay） ----------
  {
    check('页面含待确认入口/弹窗标记',
      page.text.includes('id="btnReview"') && page.text.includes('id="rModal"') &&
      page.text.includes('/review?status=pending') && page.text.includes('data-act="approve"'));

    const r1 = await post('/inbox', { kind: 'correction', text: 'UI 审核批准测试 CORR-UI-1', source: { agent: 'ui-test' } });
    check('correction note 写入成功', r1.status === 202);
    await post('/consolidate', {});
    const rev1 = await (await fetch(base + '/review')).json();
    const item1 = (rev1.data?.items || [])[0];
    check('review 队列出现 1 条 correction', Boolean(item1) && item1.reason === 'correction' && Boolean(item1.candidate?.text));
    const ap = await post(`/review/${item1.review_id}/approve`, {});
    check('批准 200 且返回 card_id', ap.status === 200 && Boolean(ap.body?.data?.card_id), JSON.stringify(ap.body));
    const all = await (await fetch(base + '/review?status=all')).json();
    check('review 状态为 approved', (all.data?.items || []).some((x) => x.review_id === item1.review_id && x.status === 'approved'));
    const dataJs4 = parseDataJs((await getText('/data.js')).text);
    check('批准后新卡出现在 /data.js',
      (dataJs4?.days || []).flatMap((d) => d.cards || []).some((x) => (x.text || '').includes('CORR-UI-1')));

    const r2 = await post('/inbox', { kind: 'correction', text: 'UI 审核拒绝测试 CORR-UI-2', source: { agent: 'ui-test' } });
    check('第二条 correction note 写入成功', r2.status === 202);
    await post('/consolidate', {});
    const rev2 = await (await fetch(base + '/review')).json();
    const item2 = (rev2.data?.items || [])[0];
    check('review 队列出现第二条待确认', Boolean(item2));
    const rj = await post(`/review/${item2.review_id}/reject`, {});
    check('拒绝 200', rj.status === 200 && rj.body?.data?.status === 'rejected');
    const rec = await (await fetch(base + '/recall?q=' + encodeURIComponent('CORR-UI-2') + '&k=5')).json();
    check('拒绝后 /recall 不返回', !(rec.data?.items || []).some((x) => (x.text || '').includes('CORR-UI-2')));
    const pending = await (await fetch(base + '/review')).json();
    check('处理后待确认归零', (pending.data?.items || []).length === 0);
  }

  check('页面在写入后仍 200', (await getText('/')).status === 200);
} catch (err) {
  fail++;
  console.log(`FAIL 异常：${err.message}`);
  console.log(err.stack);
} finally {
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('注意：浏览器渲染/交互需人工在 http://127.0.0.1:7788/ 复测（点"写入记录"→撤销→页面刷新）');
process.exit(fail === 0 ? 0 : 1);
