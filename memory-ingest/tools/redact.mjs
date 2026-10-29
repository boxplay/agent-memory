// 脱敏 CLI：默认 dry-run；--apply 才写回 data/cards.jsonl（并备份）
// 规则/替换逻辑的规范来源在 memoryd/src/redact-rules.mjs（打包自包含需要）；这里只保留 CLI。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, redactText } from '../../memoryd/src/redact-rules.mjs';

export { RULES, redactText };

function main() {
  const DATA = path.resolve('data');
  const APPLY = process.argv.includes('--apply');
  const file = path.join(DATA, 'cards.jsonl');
  const cards = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  let count = 0;
  const changedCards = [];
  for (const c of cards) {
    const beforeText = c.text || '';
    const beforeQuote = c.quote || '';
    const t = redactText(c.text);
    const q = redactText(c.quote);
    count += t.hits + q.hits;
    c.text = t.text;
    c.quote = q.text;
    if (beforeText !== (c.text || '') || beforeQuote !== (c.quote || '')) changedCards.push(c.id);
  }

  console.log('== 脱敏 ==');
  console.log('模式:', APPLY ? 'APPLY' : 'DRY-RUN');
  console.log('替换次数:', count, '| 受影响卡片:', changedCards.length, '/', cards.length);

  if (APPLY) {
    fs.copyFileSync(file, path.join(DATA, 'cards-pre-redact.jsonl'));
    fs.writeFileSync(file, cards.map(c => JSON.stringify(c)).join('\n') + '\n');
    console.log('已写回 data/cards.jsonl（备份 data/cards-pre-redact.jsonl）');
    console.log('接着执行: node tools/build-graph.mjs');
  } else {
    console.log('未修改文件；确认后加 --apply');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
