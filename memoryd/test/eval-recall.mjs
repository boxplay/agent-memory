#!/usr/bin/env node
// 20 问召回评测：题目运行时从本地数据生成（只含主题/实体/日期等通用词，不落盘卡片正文）。
// 判定规则写在每题的 judge 里；阈值 80%。负样本要求返回空（不编造）。
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { resolveConfig } from '../src/config.mjs';
import { recall } from '../src/recall.mjs';
import { addDays, localDate } from '../src/query.mjs';

const config = resolveConfig({});
const store = new Store(config);
const state = store.load();

const qa = [];

// 1) 时间题：有卡的天各一题（避免"当天无卡"导致不可答）
for (const day of state.days.list) {
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  qa.push({
    cat: 'time',
    q: `${m} 月 ${d} 日我做了什么？`,
    expect: `day=${day}`,
    judge: (items) => items.some((it) => it.day === day)
  });
}

// 2) 偏好题：按有 preference 卡的主题取前 4
const prefTopics = countTopics('preference').slice(0, 4);
for (const t of prefTopics) {
  qa.push({
    cat: 'preference',
    q: `我在${t}上有什么偏好？`,
    expect: `preference+${t}`,
    judge: (items) => items.some((it) => it.type === 'preference' && it.topics.includes(t))
  });
}

// 3) 待办题（意图词触发）
qa.push({
  cat: 'commitment',
  q: '我还有哪些待办？',
  expect: 'pending commitment',
  judge: (items) => items.some((it) => it.type === 'commitment' && it.status === 'pending')
});
qa.push({
  cat: 'commitment',
  q: '我答应过要做什么？',
  expect: 'pending commitment',
  judge: (items) => items.some((it) => it.type === 'commitment' && it.status === 'pending')
});

// 4) 决定题：优先记忆管理/语音模型，其次按数量
const decAll = countTopics('decision');
const decPreferred = ['记忆管理', '语音模型'].filter((t) => decAll.includes(t));
const decTopics = [...new Set([...decPreferred, ...decAll])].slice(0, 2);
for (const t of decTopics) {
  qa.push({
    cat: 'decision',
    q: `${t}相关的决定有哪些？`,
    expect: `decision+${t}`,
    judge: (items) => items.some((it) => it.type === 'decision' && it.topics.includes(t))
  });
}

// 5) 实体题：按出现次数取前 4
for (const { name } of state.entities.slice(0, 4)) {
  qa.push({
    cat: 'entity',
    q: `关于${name}有哪些记录？`,
    expect: `entity=${name}`,
    judge: (items) => items.some((it) => it.entities.includes(name))
  });
}

// 6) 关键词题
qa.push({
  cat: 'keyword',
  q: 'MOSS 音色',
  expect: 'text 含 moss',
  judge: (items) => items.some((it) => String(it.text).toLowerCase().includes('moss'))
});

// 负样本：问不存在的内容，必须返回空
const negative = {
  q: '我在量子计算上有什么偏好？',
  expect: 'total=0'
};

function countTopics(type) {
  const counts = new Map();
  for (const card of state.cards) {
    if (card.type !== type) continue;
    for (const t of card.topics || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

// ---------- 跑题 ----------
const rows = [];
let hits = 0;
for (const item of qa) {
  const result = recall(state, { q: item.q, k: 5 });
  const hit = item.judge(result.items);
  if (hit) hits++;
  rows.push({
    cat: item.cat,
    q: item.q,
    expect: item.expect,
    hit,
    total: result.total,
    topIds: result.items.map((it) => it.id),
    topDays: result.items.map((it) => it.day)
  });
  const mark = hit ? 'PASS' : 'MISS';
  console.log(
    `${mark} [${item.cat}] ${item.q}  期望 ${item.expect}  total=${result.total}  top=${result.items
      .slice(0, 2)
      .map((it) => `${it.type}@${it.day}`)
      .join(',')}`
  );
}

const negResult = recall(state, { q: negative.q, k: 5 });
const negOk = negResult.total === 0 && negResult.items.length === 0;
console.log(`${negOk ? 'PASS' : 'MISS'} [negative] ${negative.q}  期望 ${negative.expect}  total=${negResult.total}`);

const score = hits / qa.length;
console.log(`\n召回命中：${hits}/${qa.length} = ${(score * 100).toFixed(0)}%（阈值 80%）`);
console.log(`负样本：${negOk ? '通过' : '失败'}`);

// ---------- 落盘（只存 id/日期/计数，不存卡片正文） ----------
const outDir = config.outDir;
fs.mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  cards: state.cards.length,
  days: state.days.withCards,
  score,
  threshold: 0.8,
  hits,
  total: qa.length,
  negative: { q: negative.q, ok: negOk, total: negResult.total },
  rows
};
const outFile = path.join(outDir, 'eval-report.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`报告：${path.relative(config.root, outFile)}`);

const ok = score >= 0.8 && negOk;
process.exit(ok ? 0 : 1);
