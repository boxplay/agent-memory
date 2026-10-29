#!/usr/bin/env node
// 延迟基准：HTTP 混合 200 次，取 p50/p95/max；阈值 p95 < 200ms。
import fs from 'node:fs';
import path from 'node:path';
import { Store, round2 } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { resolveConfig } from '../src/config.mjs';

const config = resolveConfig({});
const store = new Store(config);
store.load();
const app = createApp(store, config);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

const ENDPOINTS = [
  '/health',
  '/today',
  '/profile',
  '/recall?q=' + encodeURIComponent('我在可视化上有什么偏好？') + '&k=8',
  '/recall?from=2026-10-27&to=2026-10-29&k=10',
  '/context?q=' + encodeURIComponent('体检') + '&budget=2000',
  '/graph'
];

const WARMUP = 50;
const N = 200;

for (let i = 0; i < WARMUP; i++) {
  await fetch(base + ENDPOINTS[i % ENDPOINTS.length]);
}

const samples = [];
let errors = 0;
for (let i = 0; i < N; i++) {
  const endpoint = ENDPOINTS[i % ENDPOINTS.length];
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + endpoint);
  await res.arrayBuffer();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!res.ok) errors++;
  samples.push(ms);
}
app.close();

samples.sort((a, b) => a - b);
const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const stats = {
  n: N,
  errors,
  p50: round2(pick(0.5)),
  p95: round2(pick(0.95)),
  p99: round2(pick(0.99)),
  max: round2(samples[samples.length - 1]),
  min: round2(samples[0])
};
const ok = stats.p95 < 200 && errors === 0;

console.log(`endpoints: ${ENDPOINTS.length} 种，${N} 次请求，错误 ${errors}`);
console.log(`p50=${stats.p50}ms  p95=${stats.p95}ms  p99=${stats.p99}ms  max=${stats.max}ms  min=${stats.min}ms`);
console.log(`判定：p95 ${stats.p95}ms ${ok ? '<' : '>='} 200ms → ${ok ? 'PASS' : 'FAIL'}`);

const outDir = config.outDir;
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'bench.json');
fs.writeFileSync(
  outFile,
  JSON.stringify({ generatedAt: new Date().toISOString(), endpoints: ENDPOINTS, ...stats, thresholdMs: 200, ok }, null, 2)
);
console.log(`报告：${path.relative(config.root, outFile)}`);
process.exit(ok ? 0 : 1);
