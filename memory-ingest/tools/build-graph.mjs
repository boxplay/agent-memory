#!/usr/bin/env node
// M2 · 构图：cards.jsonl -> memory/bundle.json + memory-galaxy/data.js
// 页面加载 data.js 后会用真实数据重建双球
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('..');                 // /Users/du/Documents/突如其来
const IN = path.resolve('data/cards.jsonl');
const MEM = path.resolve('memory');
const PAGE_DATA = path.join(ROOT, 'memory-galaxy', 'data.js');
fs.mkdirSync(MEM, { recursive: true });

const cards = fs.existsSync(IN)
  ? fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '').replace(/`/g, '')
    .replace(/^[#>*\-\s|]+/, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function short(t, n = 16) {
  const s = clean(t);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* 按 日期+分类 聚合 */
const dayMap = new Map();
for (const c of cards) {
  const day = c.day || (c.created_at || '').slice(0, 10);
  if (!day) continue;
  const cat = c.cat === 'daily' ? 'daily' : 'work';
  const key = day + '|' + cat;
  if (!dayMap.has(key)) dayMap.set(key, []);
  dayMap.get(key).push(c);
}

const days = [];
for (const [key, list] of [...dayMap.entries()].sort()) {
  const [date, cat] = key.split('|');
  list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const cardsOut = list.map(c => {
    const t = ['decision', 'preference', 'correction'].includes(c.type) ? c.type : 'event';
    const out = {
      id: c.id,
      t,
      text: clean(c.text),
      cat,
      topics: c.topics || [],
      entities: c.entities || [],
      quote: clean(c.quote || ''),
      source: c.source || null,
      confidence: c.confidence ?? null,
      status: c.status ?? null
    };
    if (c.type === 'commitment') out.reminds = 'cm_' + c.id;
    return out;
  });
  const kinds = list.reduce((m, c) => (m[c.type] = (m[c.type] || 0) + 1, m), {});
  const label = cat === 'daily' ? '日常' : '工作';
  const summary = `${label} · ${list.length} 条（` +
    Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join('，') + '）';
  days.push({ date, summary, cards: cardsOut });
}
days.sort((a, b) => (a.date < b.date ? -1 : 1));

/* 承诺 */
const commitments = cards.filter(c => c.type === 'commitment').map(c => ({
  id: 'cm_' + c.id,
  text: clean(c.text),
  short: short(c.text, 10),
  due: c.due_at || '',
  status: c.status || 'pending',
  fromDay: c.day,
  cat: c.cat === 'daily' ? 'daily' : 'work',
  quote: clean(c.quote || ''),
  source: c.source || null,
  confidence: c.confidence ?? null
}));

/* 主题 / 实体 */
const topicSet = new Set();
const entitySet = new Set();
for (const c of cards) {
  (c.topics || []).forEach(t => topicSet.add(t));
  (c.entities || []).forEach(e => entitySet.add(e));
}
const topics = [...topicSet];
const entities = [...entitySet];

const PROFILES = [
  { k: '身份', v: '独立开发者，做 AI 应用 + 硬件联动' },
  { k: '偏好·结论', v: '结论先行，先证据后结论' },
  { k: '偏好·表格', v: '能上表格就上表格，短句' },
  { k: '习惯', v: '夜间工作，白天回消息慢' },
  { k: '近况', v: '在推进 MOSS 语音助手与记忆可视化' },
  { k: '关系', v: '搭档：你拍板，我执行与复测' }
];

const bundle = {
  generatedAt: new Date().toISOString(),
  source: 'memory-ingest/rules (M2)',
  persona: {
    label: '阿墨',
    content: '性格：结论先行；中文；能上表格就上表格；不确定就追问，不自己补需求；复述关键点再动手。'
  },
  profiles: PROFILES,
  topics,
  entities,
  days,
  commitments,
  segments: [],
  artifacts: []
};

fs.writeFileSync(path.join(MEM, 'bundle.json'), JSON.stringify(bundle, null, 2));
fs.writeFileSync(path.join(MEM, 'graph.json'), JSON.stringify(bundle, null, 2));
fs.writeFileSync(PAGE_DATA, 'window.__MEMORY__ = ' + JSON.stringify(bundle) + ';\n');

console.log('== 构图完成 ==');
console.log('卡片:', cards.length, '| 天数:', days.length, '| 承诺:', commitments.length);
console.log('主题:', topics.length, '| 实体:', entities.length);
console.log('输出:', path.join(MEM, 'bundle.json'));
console.log('     ', PAGE_DATA);
