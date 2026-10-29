// memoryd 内部工具：文件原子写、JSONL 读写、文本归一化、简单错误类型。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ensureDir = (dir, mode = 0o700) => fs.mkdirSync(dir, { recursive: true, mode });

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 坏行跳过：写到日志由调用方负责
    }
  }
  return out;
}

export function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseJsonBody(raw) {
  if (!raw || !raw.trim()) throw new AppError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return body;
}

const PUNCT_RE = /[\s，。；：、,.;:!?！？"'“”‘’（）()【】\[\]]/g;
export const normText = (t) => String(t || '').replace(PUNCT_RE, '');

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

export function localDateOf(input) {
  const d = input instanceof Date ? input : new Date(input);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function trigrams(text) {
  const s = normText(text);
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  if (s.length < 3) out.add(s);
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function nowIso() {
  return new Date().toISOString();
}

export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}
