#!/usr/bin/env node
// 敏感信息扫描（只读）：检查记忆卡片里是否混入密钥/凭据
// 用法: node tools/scan-secrets.mjs
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve('data');
const cards = fs.readFileSync(path.join(DATA, 'cards.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const RULES = [
  { kind: 'api_key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{10,}/gi },
  { kind: 'password', re: /(密码|password|passwd)\s*[:：=]?\s*\S{3,40}/gi },
  { kind: 'token', re: /\btoken\b[^。；\n]{0,40}/gi },
  { kind: 'ip_internal', re: /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\b/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'phone', re: /\b1[3-9]\d{9}\b/g }
];

function mask(s) {
  if (s.length <= 10) return s.slice(0, 2) + '…';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

const findings = [];
for (const c of cards) {
  const blob = (c.text || '') + '\n' + (c.quote || '');
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(blob)) !== null) {
      findings.push({
        card: c.id, type: c.type, cat: c.cat, project: c.source?.project || '-',
        day: c.day, kind: r.kind, masked: mask(m[0])
      });
      if (m[0].length === 0) break;
    }
  }
}

const byKind = {};
const byProject = {};
const uniqSecret = new Set();
for (const f of findings) {
  byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  byProject[f.project] = (byProject[f.project] || 0) + 1;
  if (f.kind === 'api_key' || f.kind === 'bearer') uniqSecret.add(f.masked);
}

const report = { generatedAt: new Date().toISOString(), cards: cards.length, findings: findings.length, byKind, byProject, uniqKeys: [...uniqSecret], samples: findings.slice(0, 20) };
fs.writeFileSync(path.join(DATA, 'secrets-report.json'), JSON.stringify(report, null, 2));

console.log('== 敏感信息扫描 ==');
console.log('卡片:', cards.length, '| 命中:', findings.length);
console.log('按类型:', JSON.stringify(byKind));
console.log('按项目:', JSON.stringify(byProject));
console.log('疑似密钥:', [...uniqSecret].join(', ') || '无');
console.log('报告: data/secrets-report.json');
