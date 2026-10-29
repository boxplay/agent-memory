// 写入第二段：consolidator —— 批量分类/置信/去重/分流，生成 ac_* 卡或 review。
import fs from 'node:fs';
import path from 'node:path';
import { classify, tagsOf, parseDue } from './memory-rules.mjs';
import { overlayPaths, emptyState, findNote } from './overlay.mjs';
import {
  appendLine,
  readJson,
  writeJsonAtomic,
  normText,
  sha1,
  localDateOf,
  nowIso,
  trigrams,
  jaccard
} from './util.mjs';

const CONFIDENCE_BASE = 0.55;
const REVIEW_CONFIDENCE = 0.6;
const NEAR_DUP_JACCARD = 0.85;

export function buildAgentCard(note, preset) {
  if (preset) return preset;
  const text = String(note.text || '');
  const ts = note.ts || nowIso();
  const { cat } = classify({ project: '' }, text);
  const tags = tagsOf(text);
  const due = note.kind === 'commitment' ? parseDue(text, ts) : null;
  let confidence = CONFIDENCE_BASE + 0.15;
  if (due) confidence += 0.05;
  if (tags.topics.length > 0 || tags.entities.length > 0) confidence += 0.05;
  if (text.length >= 12) confidence += 0.05;
  confidence = Math.min(0.9, Math.round(confidence * 100) / 100);
  const day = localDateOf(ts);
  return {
    id: `ac_${sha1(note.note_id).slice(12)}`,
    type: note.kind,
    cat,
    cat_source: 'agent',
    text,
    quote: text,
    created_at: ts,
    day,
    occurred_at: day,
    due_at: due,
    status: note.kind === 'commitment' ? 'pending' : null,
    confidence,
    topics: tags.topics,
    entities: tags.entities,
    source: {
      kind: 'agent',
      agent: note.source?.agent || 'unknown',
      note_id: note.note_id,
      session: note.source?.session || null,
      ts
    }
  };
}

export function findNearDuplicate(card, pool) {
  const tri = trigrams(card.text);
  for (const other of pool) {
    if (other.type !== card.type) continue;
    if (jaccard(tri, trigrams(other.text)) >= NEAR_DUP_JACCARD) return other;
  }
  return null;
}

function acquireLock(paths) {
  try {
    fs.mkdirSync(paths.lockDir);
    fs.writeFileSync(path.join(paths.lockDir, 'pid'), String(process.pid));
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let stale = false;
    try {
      const st = fs.statSync(paths.lockDir);
      stale = Date.now() - st.mtimeMs > 5 * 60 * 1000;
    } catch {
      return acquireLock(paths);
    }
    if (!stale) return false;
    fs.rmSync(paths.lockDir, { recursive: true, force: true });
    return acquireLock(paths);
  }
}

function releaseLock(paths) {
  try {
    fs.rmSync(paths.lockDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

/** 跑一次整理；返回统计。单实例锁，重复触发会返回 locked:true。 */
export function runConsolidate({ store, overlay, config, trigger = 'manual' }) {
  const paths = overlayPaths(config);
  if (!acquireLock(paths)) return { locked: true, processed: 0, cards: 0, reviews: 0 };
  const t0 = Date.now();
  try {
    store.maybeReload();
    overlay.reload();
    const baseState = store.get();
    const snap = overlay.get();
    const state = { ...emptyState(), ...readJson(paths.state, {}) };
    state.processedNotes = state.processedNotes || [];
    const processed = new Set(state.processedNotes);
    const noteIds = new Set(snap.notes.map((n) => n.note_id));

    const pendingNotes = snap.notes.filter((n) => !processed.has(n.note_id));
    const baseKeys = new Set(baseState.cards.map((c) => `${c.type}|${normText(c.text)}`));
    const agentKeys = new Set(snap.agentCards.map((c) => `${c.type}|${normText(c.text)}`));
    const agentIds = new Set(snap.agentCards.map((c) => c.id));
    const dupPool = [...baseState.cards, ...snap.agentCards];

    const newCards = [];
    const newReviews = [];
    let noop = 0;
    for (const note of pendingNotes) {
      // 已被 review 拒绝 / 撤销过的 note 不再生成
      if (snap.hiddenNoteIds.has(note.note_id)) {
        processed.add(note.note_id);
        continue;
      }
      const card = buildAgentCard(note);
      const key = `${card.type}|${normText(card.text)}`;

      const queueReview = (reason) => {
        const reviewId = `rv_${sha1(note.note_id).slice(12)}`;
        if (snap.reviewLatest.has(reviewId) || newReviews.some((r) => r.review_id === reviewId)) {
          processed.add(note.note_id);
          return;
        }
        newReviews.push({
          review_id: reviewId,
          note_id: note.note_id,
          reason,
          candidate: card,
          created_at: nowIso(),
          status: 'pending'
        });
        processed.add(note.note_id);
      };

      if (baseKeys.has(key) || agentKeys.has(key) || agentIds.has(card.id)) {
        noop++;
        processed.add(note.note_id);
        continue;
      }
      const near = findNearDuplicate(card, dupPool);
      if (near) {
        queueReview('near_duplicate');
        continue;
      }
      if (note.kind === 'correction') {
        queueReview('correction');
        continue;
      }
      if (card.confidence < REVIEW_CONFIDENCE) {
        queueReview('low_confidence');
        continue;
      }
      newCards.push(card);
      agentIds.add(card.id);
      agentKeys.add(key);
      dupPool.push(card);
      processed.add(note.note_id);
    }

    for (const card of newCards) appendLine(paths.agentCards, card);
    for (const review of newReviews) appendLine(paths.review, review);

    // 清理已不存在的 note 游标（inbox 归档后不至于无限增长）
    state.processedNotes = [...processed].filter((id) => noteIds.has(id)).slice(-5000);
    state.consolidator = {
      lastRunAt: nowIso(),
      lastDurationMs: Date.now() - t0,
      lastTrigger: trigger,
      lastResult: { processed: pendingNotes.length, cards: newCards.length, reviews: newReviews.length, noop }
    };
    state.updatedAt = nowIso();
    writeJsonAtomic(paths.state, state);
    overlay.reload();
    return {
      locked: false,
      processed: pendingNotes.length,
      cards: newCards.length,
      reviews: newReviews.length,
      noop,
      durationMs: Date.now() - t0
    };
  } finally {
    releaseLock(paths);
  }
}

export { findNote };
