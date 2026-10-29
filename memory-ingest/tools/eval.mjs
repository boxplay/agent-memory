#!/usr/bin/env node
// M4 · 金标评估：承诺/偏好/事件是否被抽到
import fs from 'node:fs';
import path from 'node:path';
const DATA = path.resolve('data');
const cards = fs.readFileSync(path.join(DATA, 'cards.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const golden = JSON.parse(fs.readFileSync(path.join(DATA, 'golden.json'), 'utf8'));
const work = cards.filter(c => c.cat === 'work');
const blob = c => (c.text || '') + ' ' + (c.quote || '');
const rows = [];
let matched = 0;
for (const g of golden) {
  const hits = work.filter(c => g.keys.some(k => blob(c).includes(k)));
  const ok = hits.length > 0;
  if (ok) matched++;
  rows.push({ id: g.id, desc: g.desc, ok, hits: hits.slice(0, 3).map(c => c.text) });
}
const used = new Set();
for (const g of golden) {
  for (const c of work) if (g.keys.some(k => blob(c).includes(k))) used.add(c.id);
}
const recall = matched / golden.length;
const precisionProxy = used.size / Math.max(1, work.length);
const report = { generatedAt: new Date().toISOString(), cards: cards.length, workCards: work.length, golden: golden.length, matched, recall, precisionProxy, rows };
fs.writeFileSync(path.join(DATA, 'eval.json'), JSON.stringify(report, null, 2));
console.log('== 金标评估 ==');
console.log(`召回 ${matched}/${golden.length} = ${(recall * 100).toFixed(0)}%  | 卡片命中率(代理精度) ${(precisionProxy * 100).toFixed(0)}%`);
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.id} ${r.desc}${r.ok ? '  ← ' + r.hits[0] : ''}`);
