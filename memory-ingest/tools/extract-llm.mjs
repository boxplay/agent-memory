#!/usr/bin/env node
// M3 · LLM 抽取：turns.jsonl -> data/cards-llm.jsonl，并与规则卡合并
// 默认用本机 Ollama；也可切到 OpenAI 兼容接口（DeepSeek）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }

const PROVIDER = arg('provider', 'ollama');          // ollama | openai
const MODEL = arg('model', 'qwen2.5:3b');
const BASE = arg('base-url', 'http://127.0.0.1:11434');
const KEY_FILE = arg('api-key-file', '');
const API_KEY = KEY_FILE ? (fs.readFileSync(KEY_FILE, 'utf8').trim().split(/\s+/)[0]) : (process.env[arg('api-key-env', 'DEEPSEEK_API_KEY')] || '');
const BATCH = parseInt(arg('batch', '8'), 10);
const MAX_TURNS = parseInt(arg('max-turns', '0'), 10) || Infinity;
const OUT_LLM = arg('out', 'data/cards-llm.jsonl');
const INCREMENTAL = args.includes('--incremental');
const PROCESSED = path.resolve('data/llm-processed.json');

const DATA = path.resolve('data');
let allTurns = fs.readFileSync(path.join(DATA, 'turns.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(t => t.text && t.text.length >= 6);
let processed = new Set();
if (INCREMENTAL && fs.existsSync(PROCESSED)) {
  try { processed = new Set(JSON.parse(fs.readFileSync(PROCESSED, 'utf8'))); } catch {}
}
const turns = allTurns.filter(t => !processed.has(t.id)).slice(0, MAX_TURNS);
if (INCREMENTAL && turns.length === 0) {
  // 没有新轮次：仍然把已有 LLM 卡与规则卡合并到 cards.jsonl
  const outPath = path.resolve(OUT_LLM);
  const rulesPath = path.join(DATA, 'cards-rules-only.jsonl');
  const llm = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const rules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const merged = [];
  const seenSkip = new Set();
  for (const c of [...llm, ...rules]) {
    const key = c.type + '|' + String(c.text || '').replace(/\s+/g, '');
    if (seenSkip.has(key)) continue;
    seenSkip.add(key); merged.push(c);
  }
  merged.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  fs.writeFileSync(path.join(DATA, 'cards.jsonl'), merged.map(c => JSON.stringify(c)).join('\n') + '\n');
  console.log('没有新的轮次，仅合并已有结果：', merged.length, '张');
  process.exit(0);
}

const TOPICS = ['记忆管理','会话切换','竞品调研','AI 微信','语音模型','协议对照','费用','可视化','硬件','协作','评测','工程','生活','健康','家庭','娱乐'];
const ENTITIES = ['Claude Code','DSH','Cumora','唯信','小米 LX06','GitHub','Codex','Ollama'];

function hashId(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }
function clean(t) { return String(t || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim(); }

function buildPrompt(batch) {
  const lines = batch.map((t, i) =>
    `[${t._i}] ${t.day} ${t.role}: ${clean(t.text).slice(0, 260)}`
  ).join('\n');
  return `你是记忆抽取器。从对话轮次中抽取值得长期记住的记忆卡片。只输出 JSON，不要解释。

卡片类型:
- commitment: 承诺/待办/提醒（谁要做什么，什么时候）
- preference: 用户的偏好/习惯/雷区
- fact: 稳定事实（身份、项目、关系、长期设定）
- decision: 已定的方案/技术决定
- event: 重要事件/里程碑/完成的事
- correction: 更正/改口

分类 cat: work(工作/项目/技术) 或 daily(日常生活/健康/家庭/娱乐/消费)

规则:
1. 只抽 4 周后仍值得记住的；寒暄、一次性技术细节、纯过程描述不要
2. text 用陈述句，不超过 40 字
3. 有明确时间写 due_at=YYYY-MM-DD，否则 null
4. topics 只能从: ${TOPICS.join('、')}
5. entities 只能从: ${ENTITIES.join('、')}
6. 每条必须给 source_turn（方括号里的编号）
7. 没有可抽的就输出 {"cards":[]}

轮次:
${lines}

输出格式:
{"cards":[{"type":"commitment","cat":"work","text":"","due_at":null,"topics":[],"entities":[],"confidence":0.8,"source_turn":1}]}`;
}

async function callLLM(prompt) {
  if (PROVIDER === 'ollama') {
    const body = { model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', options: { temperature: 0, num_predict: 1200 } };
    const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('ollama ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const d = await r.json();
    return d.message?.content || '';
  }
  const body = { model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, response_format: { type: 'json_object' } };
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('api ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

function parseCards(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  const obj = JSON.parse(s);
  return Array.isArray(obj.cards) ? obj.cards : [];
}

const cards = [];
const newlyProcessed = [];
const byIndex = new Map();
turns.forEach((t, i) => { t._i = i; byIndex.set(i, t); });

for (let start = 0; start < turns.length; start += BATCH) {
  const batch = turns.slice(start, start + BATCH);
  let parsed = null, err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { parsed = parseCards(await callLLM(buildPrompt(batch))); break; }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 800)); }
  }
  const n = parsed ? parsed.length : 0;
  process.stdout.write(`batch ${Math.floor(start / BATCH) + 1}/${Math.ceil(turns.length / BATCH)}  turns=${batch.length}  cards=${n}${err ? '  ERR=' + String(err.message).slice(0, 60) : ''}\n`);
  if (!parsed) continue;
  batch.forEach(t => newlyProcessed.push(t.id));
  for (const c of parsed) {
    if (!c || !c.text) continue;
    const type = ['commitment','preference','fact','decision','event','correction'].includes(c.type) ? c.type : 'fact';
    const cat = c.cat === 'daily' ? 'daily' : 'work';
    const text = clean(c.text).slice(0, 80);
    if (text.length < 3) continue;
    const srcTurn = byIndex.get(Number(c.source_turn));
    const topics = (Array.isArray(c.topics) ? c.topics : []).filter(t => TOPICS.includes(t));
    const entities = (Array.isArray(c.entities) ? c.entities : []).filter(e => ENTITIES.includes(e));
    const due = /^\d{4}-\d{2}-\d{2}$/.test(c.due_at || '') ? c.due_at : null;
    cards.push({
      id: 'c_' + hashId((srcTurn ? srcTurn.id : '') + type + text),
      type, cat, cat_source: 'llm',
      text,
      quote: srcTurn ? clean(srcTurn.text).slice(0, 160) : text,
      created_at: srcTurn ? srcTurn.iso : new Date().toISOString(),
      day: srcTurn ? srcTurn.day : null,
      occurred_at: srcTurn ? srcTurn.day : null,
      due_at: due,
      status: type === 'commitment' ? 'pending' : null,
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.7,
      topics, entities,
      source: srcTurn ? { kind: srcTurn.source, project: srcTurn.project, session: srcTurn.sessionId, turn: srcTurn.id, role: srcTurn.role } : null
    });
  }
}

/* 去重（增量时与已有结果合并） */
const seen = new Set();
const uniq = [];
if (INCREMENTAL && fs.existsSync(OUT_LLM)) {
  for (const line of fs.readFileSync(OUT_LLM, 'utf8').split('\n').filter(Boolean)) {
    try { const c = JSON.parse(line); uniq.push(c); seen.add(c.type + '|' + c.text.replace(/\s+/g, '')); } catch {}
  }
}
for (const c of cards) {
  const key = c.type + '|' + c.text.replace(/\s+/g, '');
  if (seen.has(key)) continue;
  seen.add(key); uniq.push(c);
}

fs.writeFileSync(path.resolve(OUT_LLM), uniq.map(c => JSON.stringify(c)).join('\n') + '\n');
if (INCREMENTAL) {
  const setId = new Set(processed);
  newlyProcessed.forEach(id => setId.add(id));
  fs.writeFileSync(PROCESSED, JSON.stringify([...setId]));
}

/* 与规则卡合并 */
const rulesFile = path.join(DATA, 'cards-rules-only.jsonl');
const rules = fs.existsSync(rulesFile)
  ? fs.readFileSync(rulesFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
const merged = [];
const seen2 = new Set();
for (const c of [...uniq, ...rules]) {
  const key = c.type + '|' + clean(c.text).replace(/\s+/g, '');
  if (seen2.has(key)) continue;
  seen2.add(key); merged.push(c);
}
merged.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
fs.writeFileSync(path.join(DATA, 'cards.jsonl'), merged.map(c => JSON.stringify(c)).join('\n') + '\n');

const stats = {
  provider: PROVIDER, model: MODEL,
  turns: turns.length,
  llmCards: uniq.length,
  rulesCards: rules.length,
  merged: merged.length,
  byType: merged.reduce((m, c) => (m[c.type] = (m[c.type] || 0) + 1, m), {}),
  byCat: merged.reduce((m, c) => (m[c.cat] = (m[c.cat] || 0) + 1, m), {})
};
fs.writeFileSync(path.join(DATA, 'cards-stats.json'), JSON.stringify(stats, null, 2));
console.log('== 完成 ==');
console.log(JSON.stringify(stats));
