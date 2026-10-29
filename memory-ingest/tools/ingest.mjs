#!/usr/bin/env node
// 增量摄取入口：normalize -> rules -> LLM(增量) -> postprocess -> build-graph
// 用法:
//   node tools/ingest.mjs --days 2 --provider deepseek --api-key-file /Users/du/wwwdata/deepseek.txt
//   node tools/ingest.mjs --skip-llm
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }

const PROJECTS = arg('projects', '/Users/du/Documents/突如其来,/Users/du/Documents/其他,/Users/du/wwwdata/zgi-console');
const DAYS = arg('days', '7');
const PROVIDER = arg('provider', 'deepseek');
const MODEL = arg('model', PROVIDER === 'deepseek' ? 'deepseek-chat' : 'qwen2.5:3b');
const BASE = arg('base-url', PROVIDER === 'deepseek' ? 'https://api.deepseek.com' : 'http://127.0.0.1:11434');
const KEYFILE = arg('api-key-file', '');
const SKIP_LLM = args.includes('--skip-llm');

function run(name, cmdArgs) {
  console.log('\n== ' + name + ' ==');
  const r = spawnSync('node', cmdArgs, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(name + ' 失败，退出码', r.status);
    process.exit(r.status || 1);
  }
}

const t0 = Date.now();
run('归一化', ['tools/normalize.mjs', '--projects', PROJECTS, '--days', DAYS, '--merge']);
run('规则抽取', ['tools/extract-rules.mjs']);
fs.copyFileSync(path.resolve('data/cards.jsonl'), path.resolve('data/cards-rules-only.jsonl'));

if (!SKIP_LLM) {
  const llmArgs = ['tools/extract-llm.mjs', '--provider', PROVIDER, '--model', MODEL,
    '--base-url', BASE, '--incremental', '--batch', '10',
    '--out', 'data/cards-llm-' + PROVIDER + '.jsonl'];
  if (PROVIDER === 'deepseek' && KEYFILE) llmArgs.push('--api-key-file', KEYFILE);
  run('LLM 抽取（增量）', llmArgs);
}

run('后处理', ['tools/postprocess.mjs']);
run('脱敏', ['tools/redact.mjs', '--apply']);
run('构图', ['tools/build-graph.mjs']);

const state = {
  lastRun: new Date().toISOString(),
  durationMs: Date.now() - t0,
  projects: PROJECTS.split(','),
  days: Number(DAYS),
  provider: SKIP_LLM ? 'skip' : PROVIDER,
  model: SKIP_LLM ? null : MODEL
};
fs.writeFileSync(path.resolve('data/ingest-state.json'), JSON.stringify(state, null, 2));
console.log('\n完成:', JSON.stringify(state));
