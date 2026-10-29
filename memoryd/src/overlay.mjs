// overlay 事件层：inbox / cards-agent / review / feedback / state 的加载与派生状态。
// 全部 append-only 文件放在 memoryd/data/ 下；基座 cards.jsonl 不参与写入。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonl } from './util.mjs';

const RELOAD_THROTTLE_MS = 300;

export function overlayPaths(config) {
  const base = config.outDir;
  return {
    base,
    inboxDir: path.join(base, 'inbox'),
    agentCards: path.join(base, 'cards-agent.jsonl'),
    review: path.join(base, 'review.jsonl'),
    feedback: path.join(base, 'feedback.jsonl'),
    state: path.join(base, 'state.json'),
    lockDir: path.join(base, 'consolidator.lock')
  };
}

export function emptyState() {
  return {
    schema: 1,
    updatedAt: null,
    idempotency: {},
    processedNotes: [],
    daily: {},
    recent: {},
    consolidator: {}
  };
}

function loadNotes(paths) {
  let files = [];
  try {
    files = fs
      .readdirSync(paths.inboxDir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
  const notes = [];
  for (const name of files) {
    const file = path.join(paths.inboxDir, name);
    for (const note of readJsonl(file)) notes.push({ ...note, _file: name });
  }
  notes.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return notes;
}

function derive(reviews, feedback) {
  const reviewLatest = new Map();
  for (const r of reviews) {
    if (r && r.review_id) reviewLatest.set(r.review_id, r);
  }
  const reviewPending = [...reviewLatest.values()].filter((r) => r.status === 'pending');

  const hiddenCardIds = new Set();
  const hiddenNoteIds = new Set();
  const doneIds = new Set();
  const pinnedIds = new Set();

  for (const f of feedback) {
    if (!f || !f.action || !f.target) continue;
    const target = String(f.target);
    const isCard = target.startsWith('c_') || target.startsWith('ac_');
    if (f.action === 'done' && isCard) doneIds.add(target);
    if (f.action === 'pin' && isCard) pinnedIds.add(target);
    if (f.action === 'forget' || f.action === 'undo') {
      if (isCard) hiddenCardIds.add(target);
      else if (target.startsWith('n_')) hiddenNoteIds.add(target);
    }
  }
  return { reviewLatest, reviewPending, hiddenCardIds, hiddenNoteIds, doneIds, pinnedIds };
}

export class Overlay {
  constructor(config) {
    this.config = config;
    this.paths = overlayPaths(config);
    this.snap = null;
    this._lastCheck = 0;
  }

  signature() {
    const parts = [];
    for (const file of [this.paths.agentCards, this.paths.review, this.paths.feedback, this.paths.state]) {
      try {
        const st = fs.statSync(file);
        parts.push(`${path.basename(file)}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${path.basename(file)}:-`);
      }
    }
    let files = [];
    try {
      files = fs.readdirSync(this.paths.inboxDir).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      files = [];
    }
    for (const name of files) {
      try {
        const st = fs.statSync(path.join(this.paths.inboxDir, name));
        parts.push(`inbox/${name}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* 忽略 */
      }
    }
    return parts.join('|');
  }

  maybeReload() {
    const now = Date.now();
    if (now - this._lastCheck < RELOAD_THROTTLE_MS) return false;
    this._lastCheck = now;
    return this.load();
  }

  reload() {
    this._lastCheck = 0;
    return this.load();
  }

  load() {
    const sig = this.signature();
    if (this.snap && this.snap.sig === sig) return false;
    try {
      const notes = loadNotes(this.paths);
      const agentCards = readJsonl(this.paths.agentCards);
      const reviews = readJsonl(this.paths.review);
      const feedback = readJsonl(this.paths.feedback);
      const state = { ...emptyState(), ...readJson(this.paths.state, {}) };
      this.snap = {
        sig,
        loadedAt: new Date().toISOString(),
        notes,
        agentCards,
        reviews,
        feedback,
        state,
        lastError: null,
        ...derive(reviews, feedback)
      };
      return true;
    } catch (err) {
      if (this.snap) this.snap.lastError = `读取 overlay 失败：${err.message}`;
      return false;
    }
  }

  get() {
    if (!this.snap) this.load();
    return this.snap;
  }

  meta() {
    const s = this.get();
    return {
      notes: s.notes.length,
      agentCards: s.agentCards.length,
      reviewPending: s.reviewPending.length,
      feedback: s.feedback.length,
      lastConsolidateAt: s.state.consolidator?.lastRunAt || null,
      lastError: s.lastError || null
    };
  }
}

export function findNote(snap, noteId) {
  return snap.notes.find((n) => n.note_id === noteId) || null;
}

export function findReview(snap, reviewId) {
  return snap.reviewLatest.get(reviewId) || null;
}

export function recentNotes(snap, limit = 20) {
  const cardsByNote = new Map();
  for (const c of snap.agentCards) {
    if (c.source?.note_id) cardsByNote.set(c.source.note_id, c);
  }
  const reviewByNote = new Map();
  for (const r of snap.reviewPending) reviewByNote.set(r.note_id, r);
  const processed = new Set(snap.state.processedNotes || []);
  return snap.notes
    .slice(-limit)
    .reverse()
    .map((n) => {
      const card = cardsByNote.get(n.note_id) || null;
      const review = reviewByNote.get(n.note_id) || null;
      const hidden =
        snap.hiddenNoteIds.has(n.note_id) || (card && snap.hiddenCardIds.has(card.id)) || false;
      const status = hidden
        ? 'undone'
        : card
          ? 'consolidated'
          : review
            ? 'review'
            : processed.has(n.note_id)
              ? 'noop'
              : 'pending';
      return {
        note_id: n.note_id,
        kind: n.kind,
        text: n.text,
        agent: n.source?.agent || null,
        ts: n.ts,
        status,
        card_id: card?.id || null,
        review_id: review?.review_id || null
      };
    });
}

export function recentWrites(snap, limit = 20) {
  return snap.agentCards
    .slice(-limit)
    .reverse()
    .map((c) => ({
      card_id: c.id,
      note_id: c.source?.note_id || null,
      type: c.type,
      cat: c.cat,
      text: c.text,
      agent: c.source?.agent || null,
      ts: c.created_at,
      hidden:
        snap.hiddenCardIds.has(c.id) ||
        (c.source?.note_id ? snap.hiddenNoteIds.has(c.source.note_id) : false),
      done: snap.doneIds.has(c.id),
      pinned: snap.pinnedIds.has(c.id)
    }));
}
