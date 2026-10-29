// 数据层：只读 cards.jsonl + bundle.json，建内存索引，支持热重载。
// 约束：不写任何数据文件；解析失败保留旧索引并在 /health 暴露 lastError。
import fs from 'node:fs';
import path from 'node:path';

const RELOAD_THROTTLE_MS = 500;
const STALE_AFTER_MS = 26 * 3600 * 1000; // 每日 03:10 增量，超过 26h 视为过期

export class Store {
  constructor(config) {
    this.config = config;
    this.state = null;
    this._lastStatCheck = 0;
    this.paths = {
      cards: path.join(config.dataDir, 'cards.jsonl'),
      bundle: path.join(config.memoryDir, 'bundle.json')
    };
  }

  get available() {
    return this.state !== null;
  }

  /** 启动时强制加载；文件缺失/损坏直接抛错（doctor/CLI 会给出可读信息）。 */
  load() {
    const ok = this.reload(true);
    if (!ok) throw new Error(this.state?.lastError || `数据不可用：${this.paths.cards}`);
    return this.state;
  }

  /** 请求前调用：最多每 500ms 检查一次文件签名，变了就热重载。 */
  maybeReload() {
    const now = Date.now();
    if (now - this._lastStatCheck < RELOAD_THROTTLE_MS) return false;
    this._lastStatCheck = now;
    return this.reload(false);
  }

  signature() {
    try {
      const a = fs.statSync(this.paths.cards);
      const b = fs.statSync(this.paths.bundle);
      return `${a.mtimeMs}:${a.size}:${b.mtimeMs}:${b.size}`;
    } catch {
      return null;
    }
  }

  reload(force) {
    const sig = this.signature();
    if (!sig) {
      this._recordError(`数据文件缺失：${this.paths.cards} / ${this.paths.bundle}`);
      return false;
    }
    if (!force && this.state && sig === this.state.sig) return false;

    const t0 = process.hrtime.bigint();
    try {
      const cards = parseCards(this.paths.cards);
      const bundle = JSON.parse(fs.readFileSync(this.paths.bundle, 'utf8'));
      if (!Array.isArray(cards) || cards.length === 0) throw new Error('cards.jsonl 为空');
      if (!bundle || typeof bundle !== 'object') throw new Error('bundle.json 不是对象');
      const indexMs = round2(Number(process.hrtime.bigint() - t0) / 1e6);
      this.state = buildState({ cards, bundle, sig, indexMs, paths: this.paths });
      return true;
    } catch (err) {
      this._recordError(`解析失败（保留旧索引）：${err.message}`);
      return false;
    }
  }

  _recordError(message) {
    if (this.state) {
      this.state.lastError = message;
    } else {
      this.state = { lastError: message, cards: [], bundle: {}, loadedAt: null };
    }
  }

  /** 拿索引；无数据时抛 503 语义错误。 */
  get() {
    if (!this.state || !this.state.cards) {
      const err = new Error(this.state?.lastError || '数据不可用');
      err.status = 503;
      err.code = 'DATA_UNAVAILABLE';
      throw err;
    }
    return this.state;
  }
}

function parseCards(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const card = JSON.parse(s);
    if (card && typeof card === 'object' && card.id && card.text) out.push(card);
  }
  return out;
}

export function indexCards(cards) {
  const docs = cards.map((card) => ({
    card,
    text: lower(card.text),
    topics: lower((card.topics || []).join(' ')),
    ents: lower((card.entities || []).join(' ')),
    len: String(card.text || '').length
  }));

  const dayCounts = new Map();
  const topicCounts = new Map();
  const entityCounts = new Map();
  let totalLen = 0;
  const commitments = { total: 0, pending: 0, done: 0 };
  for (const { card } of docs) {
    totalLen += String(card.text || '').length;
    const day = cardDay(card);
    if (day) dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    for (const t of card.topics || []) topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
    for (const e of card.entities || []) entityCounts.set(e, (entityCounts.get(e) || 0) + 1);
    if (card.type === 'commitment') {
      commitments.total++;
      const status = card.status || 'pending';
      if (status === 'pending') commitments.pending++;
      if (status === 'done') commitments.done++;
    }
  }
  const days = [...dayCounts.keys()].sort();
  return {
    cards,
    docs,
    days: { from: days[0] || null, to: days[days.length - 1] || null, withCards: days.length, list: days },
    dayCounts,
    topics: [...topicCounts.entries()].map(([name, count]) => ({ name, count })).sort(byCountDesc),
    entities: [...entityCounts.entries()].map(([name, count]) => ({ name, count })).sort(byCountDesc),
    topicNames: [...topicCounts.keys()],
    entityNames: [...entityCounts.keys()],
    commitments,
    avgdl: totalLen / docs.length,
    dfCache: new Map()
  };
}

function buildState({ cards, bundle, sig, indexMs, paths }) {
  const index = indexCards(cards);
  const cardMtime = fs.statSync(paths.cards).mtimeMs;
  return {
    sig,
    bundle,
    indexMs,
    loadedAt: new Date().toISOString(),
    cardsMtime: new Date(cardMtime).toISOString(),
    bundleMtime: new Date(fs.statSync(paths.bundle).mtimeMs).toISOString(),
    cardsMtimeMs: cardMtime,
    lastError: null,
    ...index
  };
}

function byCountDesc(a, b) {
  return b.count - a.count || a.name.localeCompare(b.name);
}

const lower = (s) => String(s || '').toLowerCase();
export const cardDay = (card) => card.day || (card.created_at || '').slice(0, 10);
export function dataAgeSec(state) {
  return Math.round((Date.now() - state.cardsMtimeMs) / 1000);
}
export function isStale(state) {
  return Date.now() - state.cardsMtimeMs > STALE_AFTER_MS;
}
export function round2(n) {
  return Math.round(n * 100) / 100;
}
