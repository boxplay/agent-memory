// W3d export / import：单文件 JSONL（schema v1）。
// 导出：meta + 基座卡快照（可 --no-base）+ overlay 记录；导出前做凭据扫描。
// 导入：只增不改、只写 overlay、基座卡不导入；dry-run 先给计划；确定性去重，重复导入幂等。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PKG } from './config.mjs';
import { overlayPaths, emptyState } from './overlay.mjs';
import { readJson, readJsonl, appendLine, writeJsonAtomic, normText, nowIso } from './util.mjs';
import { scan } from './redact.mjs';

const SCHEMA = 1;
const RECORD_TYPES = new Set(['meta', 'baseCard', 'note', 'agentCard', 'review', 'feedback']);
function stamp() {
  return nowIso().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function riskyKinds(text) {
  return scan(text).filter((k) => ['api_key', 'bearer', 'password', 'token'].includes(k));
}

/** 导出到 JSONL；返回 {file, counts}。 */
export function exportMemory(ctx, opts = {}) {
  const { store, overlay, config } = ctx;
  const includeBase = opts.includeBase !== false;
  store.maybeReload();
  overlay.reload();
  const base = store.get();
  const snap = overlay.get();

  const file = path.resolve(opts.out || path.join(config.outDir, `export-${stamp()}.jsonl`));
  const counts = { baseCards: 0, notes: 0, agentCards: 0, reviews: 0, feedback: 0 };

  const bad = [];
  const check = (text) => {
    if (text) for (const k of riskyKinds(String(text))) bad.push(k);
  };
  for (const c of base.cards) {
    check(c.text);
    check(c.quote);
  }
  for (const n of snap.notes) check(n.text);
  for (const c of snap.agentCards) {
    check(c.text);
    check(c.quote);
  }
  if (bad.length) {
    throw new Error(`导出被拒绝：发现疑似凭据（${[...new Set(bad)].join('/')}），请先脱敏这些内容`);
  }

  const lines = [];
  lines.push(
    JSON.stringify({
      type: 'meta',
      schema: SCHEMA,
      version: PKG.version,
      exportedAt: nowIso(),
      includeBase,
      baseSha256: sha256File(store.paths.cards),
      counts
    })
  );
  if (includeBase) {
    for (const card of base.cards) {
      lines.push(JSON.stringify({ type: 'baseCard', card }));
      counts.baseCards++;
    }
  }
  for (const note of snap.notes) {
    lines.push(JSON.stringify({ type: 'note', note }));
    counts.notes++;
  }
  for (const card of snap.agentCards) {
    lines.push(JSON.stringify({ type: 'agentCard', card }));
    counts.agentCards++;
  }
  for (const review of snap.reviews) {
    lines.push(JSON.stringify({ type: 'review', review }));
    counts.reviews++;
  }
  for (const feedback of snap.feedback) {
    lines.push(JSON.stringify({ type: 'feedback', feedback }));
    counts.feedback++;
  }
  // 用最终 counts 重写 meta
  lines[0] = JSON.stringify({
    type: 'meta',
    schema: SCHEMA,
    version: PKG.version,
    exportedAt: nowIso(),
    includeBase,
    baseSha256: sha256File(store.paths.cards),
    counts
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, counts };
}


function parseExport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      throw new Error(`第 ${i + 1} 行不是合法 JSON`);
    }
    if (!RECORD_TYPES.has(rec.type)) throw new Error(`第 ${i + 1} 行记录类型未知：${rec.type}`);
    records.push(rec);
  }
  const meta = records[0];
  if (!meta || meta.type !== 'meta') throw new Error('缺少 meta 头记录');
  if (meta.schema !== SCHEMA) throw new Error(`schema 版本不符：${meta.schema}（支持 ${SCHEMA}）`);
  return { meta, records: records.slice(1) };
}

/** 导入；dryRun 只返回计划。 */
export function importMemory(ctx, opts = {}) {
  const { store, overlay, config } = ctx;
  const file = path.resolve(opts.file);
  const { meta, records } = parseExport(file);
  store.maybeReload();
  overlay.reload();
  const snap = overlay.get();
  const base = store.get();

  const noteIds = new Set(snap.notes.map((n) => n.note_id));
  const cardIds = new Set(snap.agentCards.map((c) => c.id));
  const keys = new Set([...base.cards, ...snap.agentCards].map((c) => `${c.type}|${normText(c.text)}`));
  const reviewIds = new Set(snap.reviews.map((r) => r.review_id));
  const feedbackIds = new Set(snap.feedback.map((f) => f.feedback_id));

  const plan = { notes: 0, agentCards: 0, reviews: 0, feedback: 0, skippedNotes: 0, skippedCards: 0, skippedReviews: 0, skippedFeedback: 0, baseCardsSkipped: 0, baseShaMatch: meta.baseSha256 === sha256File(store.paths.cards) };
  const toAppend = { notes: [], agentCards: [], reviews: [], feedback: [] };

  for (const rec of records) {
    if (rec.type === 'baseCard') {
      plan.baseCardsSkipped++;
      continue;
    }
    if (rec.type === 'note') {
      const note = rec.note;
      if (noteIds.has(note.note_id)) {
        plan.skippedNotes++;
        continue;
      }
      noteIds.add(note.note_id);
      toAppend.notes.push({ ...note, imported: true });
      plan.notes++;
      continue;
    }
    if (rec.type === 'agentCard') {
      const card = rec.card;
      const key = `${card.type}|${normText(card.text)}`;
      if (cardIds.has(card.id) || keys.has(key)) {
        plan.skippedCards++;
        continue;
      }
      cardIds.add(card.id);
      keys.add(key);
      toAppend.agentCards.push({
        ...card,
        imported: true,
        source: { ...(card.source || {}), imported: true }
      });
      plan.agentCards++;
      continue;
    }
    if (rec.type === 'review') {
      const review = rec.review;
      if (reviewIds.has(review.review_id)) {
        plan.skippedReviews++;
        continue;
      }
      reviewIds.add(review.review_id);
      toAppend.reviews.push(review);
      plan.reviews++;
      continue;
    }
    if (rec.type === 'feedback') {
      const feedback = rec.feedback;
      if (feedbackIds.has(feedback.feedback_id)) {
        plan.skippedFeedback++;
        continue;
      }
      feedbackIds.add(feedback.feedback_id);
      toAppend.feedback.push(feedback);
      plan.feedback++;
    }
  }

  if (opts.dryRun) return { dryRun: true, file, meta, plan };

  const paths = overlayPaths(config);
  for (const note of toAppend.notes) appendLine(path.join(paths.inboxDir, `${String(note.ts).slice(0, 10)}.jsonl`), note);
  for (const card of toAppend.agentCards) appendLine(paths.agentCards, card);
  for (const review of toAppend.reviews) appendLine(paths.review, review);
  for (const feedback of toAppend.feedback) appendLine(paths.feedback, feedback);

  const report = { importedAt: nowIso(), file, meta: { schema: meta.schema, version: meta.version, exportedAt: meta.exportedAt }, plan };
  writeJsonAtomic(path.join(config.outDir, 'import-report.json'), report);
  overlay.reload();
  return { dryRun: false, file, plan, applied: plan };
}
