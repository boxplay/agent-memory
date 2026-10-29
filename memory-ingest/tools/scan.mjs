#!/usr/bin/env node
// M1 · 扫描本地会话数据（只读）
// 用法: node tools/scan.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  SRC, HOME, walk, sizeOf, readFirstZstdLine, streamZstdLines, streamJsonLines,
  tryJson, decodeDshSlug, iso, dayOf
} from './lib.mjs';

const OUT = path.resolve('data/inventory.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

async function scanDsh() {
  const files = walk(SRC.dshSessions, p => p.endsWith('session.v4.jsonl.zstd'));
  const sessions = [];
  for (const file of files) {
    const first = await readFirstZstdLine(file);
    const head = tryJson(first) || {};
    const st = fs.statSync(file);
    sessions.push({
      source: 'dsh',
      file,
      sessionId: head.id || path.basename(path.dirname(file)),
      cwd: head.cwd || decodeDshSlug(path.basename(path.dirname(path.dirname(file)))),
      createdAt: head.createdAt || st.birthtimeMs,
      size: st.size,
      mtime: st.mtimeMs,
      day: dayOf(head.createdAt || st.birthtimeMs)
    });
  }
  return group(sessions);
}

async function scanClaude() {
  const files = walk(SRC.claudeProjects, p => p.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    let cwd = null, first = null, last = null, lines = 0;
    await streamJsonLines(file, line => {
      const d = tryJson(line);
      if (!d) return;
      lines++;
      if (!cwd && d.cwd) cwd = d.cwd;
      if (d.timestamp) { if (!first) first = d.timestamp; last = d.timestamp; }
    });
    const st = fs.statSync(file);
    sessions.push({
      source: 'claude',
      file,
      sessionId: path.basename(file, '.jsonl'),
      cwd: cwd || '(unknown)',
      createdAt: first ? Date.parse(first) : st.birthtimeMs,
      lastAt: last ? Date.parse(last) : null,
      size: st.size,
      mtime: st.mtimeMs,
      day: first ? first.slice(0, 10) : dayOf(st.birthtimeMs),
      lines
    });
  }
  return group(sessions);
}

async function scanCodex() {
  const files = walk(SRC.codexSessions, p => /rollout-.*\.jsonl$/.test(p));
  const sessions = [];
  for (const file of files) {
    let cwd = null, first = null, last = null, lines = 0;
    await streamJsonLines(file, line => {
      const d = tryJson(line);
      if (!d) return;
      lines++;
      if (!cwd && d.type === 'session_meta' && d.payload && d.payload.cwd) cwd = d.payload.cwd;
      if (d.timestamp) { if (!first) first = d.timestamp; last = d.timestamp; }
    });
    const st = fs.statSync(file);
    sessions.push({
      source: 'codex',
      file,
      sessionId: path.basename(file, '.jsonl').replace(/^rollout-/, ''),
      cwd: cwd || '(unknown)',
      createdAt: first ? Date.parse(first) : st.birthtimeMs,
      lastAt: last ? Date.parse(last) : null,
      size: st.size,
      mtime: st.mtimeMs,
      day: first ? first.slice(0, 10) : dayOf(st.birthtimeMs),
      lines
    });
  }
  return group(sessions);
}

function group(sessions) {
  const byProject = {};
  for (const s of sessions) {
    const key = s.cwd || '(unknown)';
    byProject[key] = byProject[key] || { cwd: key, count: 0, size: 0, sessions: [], sources: {} };
    const g = byProject[key];
    g.count++;
    g.size += s.size;
    g.sessions.push(s);
    g.sources[s.source] = (g.sources[s.source] || 0) + 1;
    if (!g.firstAt || s.createdAt < g.firstAt) g.firstAt = s.createdAt;
    const end = s.lastAt || s.mtime;
    if (!g.lastAt || end > g.lastAt) g.lastAt = end;
  }
  for (const g of Object.values(byProject)) {
    g.sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    g.firstIso = iso(g.firstAt);
    g.lastIso = iso(g.lastAt);
  }
  return Object.values(byProject).sort((a, b) => b.size - a.size);
}

const dsh = await scanDsh();
const claude = await scanClaude();
const codex = await scanCodex();

const inventory = {
  generatedAt: new Date().toISOString(),
  home: HOME,
  dsh,
  claude,
  codex,
  totals: {
    dshFiles: dsh.reduce((n, g) => n + g.count, 0),
    dshSize: dsh.reduce((n, g) => n + g.size, 0),
    claudeFiles: claude.reduce((n, g) => n + g.count, 0),
    claudeSize: claude.reduce((n, g) => n + g.size, 0),
    codexFiles: codex.reduce((n, g) => n + g.count, 0),
    codexSize: codex.reduce((n, g) => n + g.size, 0)
  }
};
fs.writeFileSync(OUT, JSON.stringify(inventory, null, 2));

const mb = n => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log('== 扫描完成 ==');
console.log(`DSH      : ${inventory.totals.dshFiles} 个会话, ${mb(inventory.totals.dshSize)}, ${dsh.length} 个项目`);
console.log(`Claude   : ${inventory.totals.claudeFiles} 个会话, ${mb(inventory.totals.claudeSize)}, ${claude.length} 个项目`);
console.log(`Codex    : ${inventory.totals.codexFiles} 个会话, ${mb(inventory.totals.codexSize)}, ${codex.length} 个项目`);
console.log('\n== 按项目（前 12）==');
for (const g of dsh.slice(0, 12)) {
  console.log(`${mb(g.size).padStart(8)}  ${String(g.count).padStart(4)} 个  ${g.cwd}  (${g.firstIso?.slice(0, 10)} ~ ${g.lastIso?.slice(0, 10)})`);
}
console.log(`\n清单已写入 ${OUT}`);
