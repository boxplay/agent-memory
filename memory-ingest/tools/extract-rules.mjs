#!/usr/bin/env node
// M2 · 规则抽取：turns.jsonl -> cards.jsonl（候选记忆卡，不调用 LLM）
// 用法: node tools/extract-rules.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classify, tagsOf, parseDue } from './memory-rules.mjs';

const IN = path.resolve('data/turns.jsonl');
const OUT_DIR = path.resolve('data');
const turns = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));


/* ---------- 规则 ---------- */
const RULES = [
  { type:'commitment', weight:0.85, re:/承诺[:：]\s*([^\n。；]{2,60})/ },
  { type:'commitment', weight:0.7,  re:/(提醒我[^\n。；]{2,50}|记得[^\n。；]{2,50}|别忘[^\n。；]{2,50}|要交[^\n。；]{0,30}|提交[^\n。；]{0,30}|预约[^\n。；]{0,30})/ },
  { type:'preference', weight:0.65, re:/(我喜欢[^\n。；]{2,50}|我讨厌[^\n。；]{2,50}|我不喜欢[^\n。；]{2,50}|偏好[^\n。；]{2,50}|习惯[^\n。；]{2,40}|不要用[^\n。；]{2,40}|尽量[^\n。；]{2,40})/ },
  { type:'decision',   weight:0.6,  re:/(定了[^\n。；]{2,50}|决定[^\n。；]{2,50}|就用[^\n。；]{2,50}|改成[^\n。；]{2,50}|先不[^\n。；]{2,40})/ },
  { type:'correction', weight:0.7,  re:/(更正[:：]?[^\n。；]{2,60}|其实不是[^\n。；]{2,50}|说错了[^\n。；]{2,50})/ }
];

function sentenceAround(text, matchText) {
  const parts = text.split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(Boolean);
  const hit = parts.find(p => p.includes(matchText)) || matchText;
  return hit.length > 120 ? hit.slice(0, 120) + '…' : hit;
}

function hashId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

const cards = [];
const seen = new Set();
const stats = { scanned: turns.length, candidates: 0, byType: {}, byCat: {} };

for (const t of turns) {
  const text = t.text || '';
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const raw = m[1] || m[0];
    const quote = sentenceAround(text, raw);
    // 降噪：承诺/偏好/更正只认用户说的话（或显式"承诺："）
    if (rule.type !== 'decision' && t.role !== 'user' && !/承诺[:：]/.test(text)) continue;
    if (rule.type === 'decision') {
      if (/[?？]/.test(quote)) continue;
      if (/(你决定|要不要|如果|建议|可以|是否|帮我挑|你说)/.test(quote)) continue;
      if (quote.length > 90) continue;
    }
    if (/^(窗外|台词|旁白)/.test(quote)) continue;
    const key = rule.type + '|' + quote.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const cls = classify(t, quote + text.slice(0, 200));
    const tags = tagsOf(quote + ' ' + text.slice(0, 200));
    const due = rule.type === 'commitment' ? parseDue(quote + ' ' + text, t.ts) : null;
    const card = {
      id: 'c_' + hashId(t.id + rule.type + quote),
      type: rule.type,
      cat: cls.cat,
      cat_source: cls.why,
      text: quote.replace(/^[#>*\-\s]+/, '').slice(0, 120),
      quote,
      created_at: t.iso,
      day: t.day,
      occurred_at: t.day,
      due_at: due,
      status: rule.type === 'commitment' ? 'pending' : null,
      confidence: rule.weight,
      topics: tags.topics,
      entities: tags.entities,
      source: { kind: t.source, project: t.project, session: t.sessionId, turn: t.id, role: t.role }
    };
    cards.push(card);
    stats.byType[card.type] = (stats.byType[card.type] || 0) + 1;
    stats.byCat[card.cat] = (stats.byCat[card.cat] || 0) + 1;
    break; // 一条 turn 最多一张卡
  }
}

/* ---------- 事件补充：assistant 的完成类标题/句 ---------- */
const HEAD_SKIP = /(结论|建议|方案|下一步|问题|背景|目录|总览|原因|注意|风险|参考|附录|选项|对比|清单)/;
function stripMd(t) {
  return t.replace(/\*\*/g, '').replace(/`/g, '').replace(/^[#>*\-\s]+/, '').replace(/[|｜]/g, ' ').trim();
}
for (const t of turns) {
  if (t.role !== 'assistant') continue;
  const text = t.text || '';
  let title = null;
  const hm = text.match(/^#{1,4}\s*([^\n]{4,40})/m);
  if (hm && /(完成|做好|修复|跑通|成功|上线|改掉|实测|搞定|已停|已改)/.test(hm[1]) && !HEAD_SKIP.test(hm[1]) && !/[?？]/.test(hm[1])) title = hm[1];
  if (!title) {
    const sm = text.match(/(已修复|已完成|做好了|跑通了|实测完成|克隆成功|已经改掉|已上线)[^\n。；]{0,30}/);
    if (sm) title = sm[0];
  }
  if (!title) continue;
  title = stripMd(title).slice(0, 60);
  if (title.length < 4) continue;
  const key = 'event|' + title;
  if (seen.has(key)) continue;
  seen.add(key);
  const cls = classify(t, title + ' ' + text.slice(0, 200));
  const tags = tagsOf(title + ' ' + text.slice(0, 200));
  cards.push({
    id: 'c_' + hashId(t.id + 'event' + title),
    type: 'event',
    cat: cls.cat,
    cat_source: cls.why,
    text: title,
    quote: title,
    created_at: t.iso,
    day: t.day,
    occurred_at: t.day,
    due_at: null,
    status: null,
    confidence: 0.6,
    topics: tags.topics,
    entities: tags.entities,
    source: { kind: t.source, project: t.project, session: t.sessionId, turn: t.id, role: t.role }
  });
  stats.byType.event = (stats.byType.event || 0) + 1;
  stats.byCat[cls.cat] = (stats.byCat[cls.cat] || 0) + 1;
}

cards.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
fs.writeFileSync(path.join(OUT_DIR, 'cards.jsonl'), cards.map(c => JSON.stringify(c)).join('\n') + '\n');
stats.candidates = cards.length;
fs.writeFileSync(path.join(OUT_DIR, 'cards-stats.json'), JSON.stringify(stats, null, 2));

/* 人工核对用 markdown */
const byDay = {};
for (const c of cards) (byDay[c.day] = byDay[c.day] || []).push(c);
const lines = ['# 规则抽取候选（M2）', '', `共 ${cards.length} 张；来源 ${turns.length} 条轮次`, ''];
for (const day of Object.keys(byDay).sort()) {
  lines.push(`## ${day}`, '');
  for (const c of byDay[day]) {
    lines.push(`- \`${c.type}/${c.cat}\` **${c.text}**`);
    if (c.due_at) lines.push(`  - 截止：${c.due_at}`);
    if (c.topics.length) lines.push(`  - 话题：${c.topics.join('、')}`);
    if (c.entities.length) lines.push(`  - 实体：${c.entities.join('、')}`);
    lines.push(`  - 原文：${c.quote}`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(OUT_DIR, 'cards-review.md'), lines.join('\n'));

console.log('== 规则抽取完成 ==');
console.log('轮次:', turns.length, '| 候选卡:', cards.length);
console.log('按类型:', JSON.stringify(stats.byType));
console.log('按分类:', JSON.stringify(stats.byCat));
console.log('输出: data/cards.jsonl, data/cards-stats.json, data/cards-review.md');
