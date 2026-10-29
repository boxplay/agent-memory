#!/usr/bin/env node
// M1 · 归一化：本地会话 -> 统一 turns.jsonl（只读源数据）
// 用法:
//   node tools/normalize.mjs --project /Users/du/Documents/突如其来 --days 7
import fs from 'node:fs';
import path from 'node:path';
import {
  SRC, HOME, walk, sizeOf, readFirstZstdLine, streamZstdLines, streamJsonLines,
  tryJson, decodeDshSlug, cleanText, contentText, iso, dayOf
} from './lib.mjs';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PROJECT = arg('project', '/Users/du/Documents/突如其来');
const PROJECTS = (arg('projects', '') || PROJECT).split(',').map(x => x.trim()).filter(Boolean);
const MERGE = args.includes('--merge');
const PROJECT_SET = new Set(PROJECTS);
const DAYS = parseInt(arg('days', '7'), 10);
const SINCE = Date.now() - DAYS * 86400 * 1000;
const OUT_DIR = path.resolve(arg('out-dir', 'data'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const turns = [];
const stats = {
  project: PROJECT,
  since: iso(SINCE),
  generatedAt: new Date().toISOString(),
  sources: {},
  dropped: { injected: 0, empty: 0, systemRole: 0 },
  perDay: {},
  perRole: { user: 0, assistant: 0 }
};

function addTurn(t) {
  if (!t.text || t.text.trim().length < 2) { stats.dropped.empty++; return; }
  turns.push(t);
  const d = dayOf(t.ts);
  stats.perDay[d] = (stats.perDay[d] || 0) + 1;
  stats.perRole[t.role]++;
}

function countSource(src, files, events, raw) {
  stats.sources[src] = stats.sources[src] || { files: 0, events: 0, rawMessages: 0 };
  stats.sources[src].files += files;
  stats.sources[src].events += events;
  stats.sources[src].rawMessages += raw;
}

function isNoise(text) {
  if (!text) return true;
  if (/^\s*Current runtime context\./i.test(text)) return true;
  if (/^\s*<system-reminder>/i.test(text)) return true;
  if (/^\s*#\s*AGENTS\.md/i.test(text)) return true;
  return false;
}

/* ---------- DSH ---------- */
async function readDsh() {
  const files = walk(SRC.dshSessions, p => p.endsWith('session.v4.jsonl.zstd'));
  let used = 0, events = 0, raw = 0;
  for (const file of files) {
    const head = tryJson(await readFirstZstdLine(file)) || {};
    const cwd = head.cwd || '';
    if (!PROJECT_SET.has(cwd)) continue;
    const createdAt = head.createdAt || fs.statSync(file).birthtimeMs;
    if (createdAt < SINCE) continue;
    used++;
    const sessionId = head.id || path.basename(path.dirname(file));
    await streamZstdLines(file, line => {
      const d = tryJson(line);
      if (!d) return;
      events++;
      const type = d.type;
      const t = d.time || d.data?.time;
      if (type === 'user/message') {
        raw++;
        const text = contentText(d.data?.content);
        if (isNoise(text)) { stats.dropped.injected++; return; }
        const c = cleanText(text);
        if (!c) { stats.dropped.injected++; return; }
        addTurn({
          id: `dsh:${sessionId}:${d.seq}`,
          source: 'dsh', project: cwd, sessionId,
          ts: t, iso: iso(t), day: dayOf(t),
          role: 'user', text: c,
          turn: d.data?.turn ?? null, seq: d.seq
        });
      } else if (type === 'assistant/message') {
        raw++;
        const msg = d.data?.message || {};
        const text = contentText(msg.content);
        const c = cleanText(text);
        if (!c) return;
        addTurn({
          id: `dsh:${sessionId}:${d.seq}`,
          source: 'dsh', project: cwd, sessionId,
          ts: t, iso: iso(t), day: dayOf(t),
          role: 'assistant', text: c,
          turn: d.data?.turn ?? null, step: d.data?.step ?? null, seq: d.seq
        });
      }
    });
  }
  countSource('dsh', used, events, raw);
}

/* ---------- Claude Code ---------- */
async function readClaude() {
  const files = walk(SRC.claudeProjects, p => p.endsWith('.jsonl'));
  let used = 0, events = 0, raw = 0;
  for (const file of files) {
    let cwd = null, lastTs = 0;
    const entries = [];
    await streamJsonLines(file, line => {
      const d = tryJson(line);
      if (!d) return;
      events++;
      if (!cwd && d.cwd) cwd = d.cwd;
      if (d.timestamp) lastTs = Math.max(lastTs, Date.parse(d.timestamp) || 0);
      entries.push(d);
    });
    if (cwd && !PROJECT_SET.has(cwd)) continue;
    if (lastTs && lastTs < SINCE) continue;
    used++;
    const sessionId = path.basename(file, '.jsonl');
    for (const d of entries) {
      if (d.type !== 'user' && d.type !== 'assistant') continue;
      raw++;
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (!ts || ts < SINCE) continue;
      const text = cleanText(contentText(d.message?.content));
      if (!text) { stats.dropped.empty++; continue; }
      addTurn({
        id: `claude:${sessionId}:${d.uuid || ts}`,
        source: 'claude', project: cwd || PROJECTS[0], sessionId,
        ts, iso: iso(ts), day: dayOf(ts),
        role: d.type, text,
        uuid: d.uuid || null
      });
    }
  }
  countSource('claude', used, events, raw);
}

/* ---------- Codex ---------- */
async function readCodex() {
  const files = walk(SRC.codexSessions, p => /rollout-.*\.jsonl$/.test(p));
  let used = 0, events = 0, raw = 0;
  for (const file of files) {
    let cwd = null, lastTs = 0;
    const entries = [];
    await streamJsonLines(file, line => {
      const d = tryJson(line);
      if (!d) return;
      events++;
      if (!cwd && d.type === 'session_meta' && d.payload?.cwd) cwd = d.payload.cwd;
      if (d.timestamp) lastTs = Math.max(lastTs, Date.parse(d.timestamp) || 0);
      entries.push(d);
    });
    if (cwd && !PROJECT_SET.has(cwd)) continue;
    if (lastTs && lastTs < SINCE) continue;
    used++;
    const sessionId = path.basename(file, '.jsonl').replace(/^rollout-/, '');
    for (const d of entries) {
      if (d.type !== 'response_item') continue;
      const p = d.payload || {};
      if (p.type !== 'message') continue;
      if (p.role !== 'user' && p.role !== 'assistant') { stats.dropped.systemRole++; continue; }
      raw++;
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (!ts || ts < SINCE) continue;
      const text = cleanText(contentText(p.content));
      if (!text) { stats.dropped.empty++; continue; }
      addTurn({
        id: `codex:${sessionId}:${d.ordinal}`,
        source: 'codex', project: cwd || PROJECTS[0], sessionId,
        ts, iso: iso(ts), day: dayOf(ts),
        role: p.role, text,
        ordinal: d.ordinal
      });
    }
  }
  countSource('codex', used, events, raw);
}

await readDsh();
await readClaude();
await readCodex();

turns.sort((a, b) => a.ts - b.ts);

/* 写 turns.jsonl（--merge 时按 id 合并） */
const turnsFile = path.join(OUT_DIR, 'turns.jsonl');
let finalTurns = turns.slice();
if (MERGE && fs.existsSync(turnsFile)) {
  const old = fs.readFileSync(turnsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const map = new Map(old.map(t => [t.id, t]));
  for (const t of turns) map.set(t.id, t);
  finalTurns = [...map.values()].sort((a, b) => a.ts - b.ts);
}
fs.writeFileSync(turnsFile, finalTurns.map(t => JSON.stringify(t)).join('\n') + '\n');
stats.turns = finalTurns.length;
turns.length = 0; turns.push(...finalTurns);

/* 统计 */
stats.turns = turns.length;
stats.range = turns.length ? { from: turns[0].iso, to: turns[turns.length - 1].iso } : null;
stats.perDay = Object.fromEntries(Object.entries(stats.perDay).sort());
fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2));

/* 20 条样例（按时间均匀抽样） */
const sample = [];
const want = 20;
for (let i = 0; i < want; i++) {
  const idx = Math.min(turns.length - 1, Math.floor((i + 0.5) * turns.length / want));
  if (turns[idx]) sample.push(turns[idx]);
}
function fmtTs(ms) {
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
const md = [
  '# 会话归一化样例（20 条）',
  '',
  `- 项目：${PROJECT}`,
  `- 时间窗：最近 ${DAYS} 天（自 ${iso(SINCE)}）`,
  `- 总轮次：${turns.length}（user ${stats.perRole.user} / assistant ${stats.perRole.assistant}）`,
  '',
  '| # | 时间 | 来源 | 角色 | 文本（截断 300 字） |',
  '|---|---|---|---|---|'
];
sample.forEach((t, i) => {
  const text = t.text.replace(/\s+/g, ' ').slice(0, 300).replace(/\|/g, '｜');
  md.push(`| ${i + 1} | ${fmtTs(t.ts)} | ${t.source} | ${t.role} | ${text} |`);
});
fs.writeFileSync(path.join(OUT_DIR, 'sample-turns.md'), md.join('\n') + '\n');

const mb = n => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log('== 归一化完成 ==');
console.log(`项目: ${PROJECT}`);
console.log(`时间窗: 最近 ${DAYS} 天`);
console.log(`轮次: ${turns.length}  (user ${stats.perRole.user} / assistant ${stats.perRole.assistant})`);
console.log(`范围: ${stats.range?.from || '-'} ~ ${stats.range?.to || '-'}`);
console.log('按来源:', JSON.stringify(stats.sources));
console.log('按天:', JSON.stringify(stats.perDay));
console.log('丢弃:', JSON.stringify(stats.dropped));
console.log(`输出:\n  ${turnsFile}\n  ${path.join(OUT_DIR, 'stats.json')}\n  ${path.join(OUT_DIR, 'sample-turns.md')}`);
