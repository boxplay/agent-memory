#!/usr/bin/env node
// M4 · 后处理：承诺状态/时间修正 + 去重 + 日常种子合并
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const MEM = path.resolve('memory');
const IN = path.join(DATA, 'cards.jsonl');
const RAW = path.join(DATA, 'cards-raw.jsonl');
const SEED = path.join(MEM, 'daily-seed.json');

const cards = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
fs.writeFileSync(RAW, cards.map(c => JSON.stringify(c)).join('\n') + '\n');

const DONE_RE = /(已|完成|修复了|已修复|关闭了|已关闭|搞定|跑通|上线了|做好了|处理完|成功|删除|替换成|改成)/;
const WD = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7 };
function fmt(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${dd}`;}
function addDays(base,n){const d=new Date(base);d.setDate(d.getDate()+n);return d;}
function parseDue(text, ts){
  const base = new Date(ts || Date.now());
  let m;
  if((m=text.match(/(\d{1,2})月(\d{1,2})[日号]/))) return `${base.getFullYear()}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  if(/大后天/.test(text)) return fmt(addDays(base,3));
  if(/后天/.test(text)) return fmt(addDays(base,2));
  if(/明天/.test(text)) return fmt(addDays(base,1));
  if(/今天/.test(text)) return fmt(base);
  if((m=text.match(/下(?:周|星期)([一二三四五六日天])/))){
    const target=WD[m[1]], cur=base.getDay()===0?7:base.getDay();
    let delta=(target-cur+7)%7; if(delta===0) delta=7; return fmt(addDays(base,delta+7));
  }
  if((m=text.match(/(?:周|星期)([一二三四五六日天])/))){
    const target=WD[m[1]], cur=base.getDay()===0?7:base.getDay();
    let delta=(target-cur+7)%7; if(delta===0) delta=7; return fmt(addDays(base,delta));
  }
  if(/月底/.test(text)){ const d=new Date(base.getFullYear(),base.getMonth()+1,0); return fmt(d); }
  return null;
}
function norm(t){ return String(t||'').replace(/[\s，。；：、,.;:!?！？"'“”‘’（）()【】\[\]]/g,''); }

for (const c of cards) {
  const blob = (c.text || '') + ' ' + (c.quote || '');
  // decision 清理：把“已完成/已删除/已迁移”类改成 event；丢掉“你决定/要不要/建议”类噪声
  if (c.type === 'decision') {
    if (/(已删除|已搭建|已用|已完成|已修复|已迁移|已经|顺带修|现在已|已改成|已停止)/.test(c.text)) {
      c.type = 'event';
    } else if (/(这决定|你决定|要不要|如果|建议|可以|是否|待定|取决于|需要你)/.test(c.text)) {
      c.drop = true;
    }
  }
  if (c.type === 'commitment') {
    c.status = DONE_RE.test(blob) ? 'done' : 'pending';
    if (!c.due_at) c.due_at = parseDue(blob, Date.parse(c.created_at || '') || Date.now());
  } else {
    c.status = null;
  }
}

/* 去重（同类型 + 归一化文本） */
const seen = new Set();
const uniq = [];
for (const c of cards) {
  if (c.drop) continue;
  const key = c.type + '|' + norm(c.text);
  if (seen.has(key)) continue;
  seen.add(key); uniq.push(c);
}

/* 日常种子 */
let seeds = [];
try { seeds = JSON.parse(fs.readFileSync(SEED, 'utf8')); } catch { seeds = []; }
for (const s of seeds) {
  const id = 'seed_' + Buffer.from(norm(s.text)).toString('hex').slice(0, 10);
  if (seen.has((s.type || 'event') + '|' + norm(s.text))) continue;
  seen.add((s.type || 'event') + '|' + norm(s.text));
  uniq.push({
    id,
    type: s.type || 'event',
    cat: 'daily',
    cat_source: 'manual-seed',
    text: s.text,
    quote: s.text,
    created_at: (s.day || '2026-10-29') + 'T12:00:00+08:00',
    day: s.day,
    occurred_at: s.day,
    due_at: s.due_at || null,
    status: s.type === 'commitment' ? 'pending' : null,
    confidence: 1,
    topics: s.topics || [],
    entities: [],
    source: { kind: 'manual-seed', note: s.note || '' }
  });
}

uniq.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
fs.writeFileSync(IN, uniq.map(c => JSON.stringify(c)).join('\n') + '\n');

const byType = uniq.reduce((m, c) => (m[c.type] = (m[c.type] || 0) + 1, m), {});
const byCat = uniq.reduce((m, c) => (m[c.cat] = (m[c.cat] || 0) + 1, m), {});
const done = uniq.filter(c => c.status === 'done').length;
const due = uniq.filter(c => c.due_at).length;
console.log('== 后处理完成 ==');
console.log('卡片:', uniq.length, '| 类型:', JSON.stringify(byType));
console.log('分类:', JSON.stringify(byCat), '| 已完成承诺:', done, '| 带截止:', due);
