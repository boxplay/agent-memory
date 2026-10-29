// 记忆摄取管线 · 公共工具
// 只读本地数据；所有读取都不修改源文件
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const HOME = os.homedir();

export const SRC = {
  dshSessions: path.join(HOME, '.dsh', 'sessions'),
  claudeProjects: path.join(HOME, '.claude', 'projects'),
  codexSessions: path.join(HOME, '.codex', 'sessions')
};

export function walk(dir, filter, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, filter, out);
    else if (ent.isFile() && filter(p)) out.push(p);
  }
  return out;
}

export function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// zstd 流式逐行读取（DSH）
export function streamZstdLines(file, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-dc', file]);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let n = 0;
    rl.on('line', line => { n++; onLine(line); });
    child.on('error', reject);
    child.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

// 明文 JSONL 逐行读取
export function streamJsonLines(file, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    let n = 0;
    rl.on('line', line => { n++; if (line.trim()) onLine(line); });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

// 读取 zstd 文件第一行（DSH session header）
export function readFirstZstdLine(file) {
  return new Promise((resolve) => {
    const child = spawn('zstd', ['-dc', file]);
    let buf = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { child.kill(); } catch {} resolve(v); };
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) finish(buf.slice(0, i));
    });
    child.on('error', () => finish(''));
    child.on('close', () => finish(buf.split('\n')[0] || ''));
    setTimeout(() => finish(buf.split('\n')[0] || ''), 4000);
  });
}

export function tryJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// DSH 目录名是 cwd 的转义（仅用于没有 header 时的兜底）
export function decodeDshSlug(slug) {
  let s = slug.replace(/^--/, '').replace(/--$/, '');
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return '/' + s.replace(/-/g, '/');
}

// 系统注入消息清洗
export function cleanText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  t = t.replace(/<runtime-context>[\s\S]*?<\/runtime-context>/gi, '');
  t = t.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '');
  if (/^\s*Current runtime context\./i.test(t)) return '';
  if (/^\s*#\s*AGENTS\.md/i.test(t)) return '';
  if (/^\s*Agent Teams is available/i.test(t)) return '';
  if (/^\s*Time sampled while preparing/i.test(t)) return '';
  if (/^\s*Elapsed since the preceding/i.test(t)) return '';
  if (/^\s*background job\s/i.test(t)) return '';
  if (/^\s*Team message from\s/i.test(t)) return '';
  if (/^\s*Job\s+[a-z0-9-]+\s+(started|finished)/i.test(t)) return '';
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && (c.type === 'text' || c.type === 'input_text')).map(c => c.text || '').join('\n');
}

export function iso(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

export function dayOf(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
