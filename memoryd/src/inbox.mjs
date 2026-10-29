// 写入第一段：POST /inbox / MCP memory_note —— 校验 + 强制脱敏 + 幂等 + 限流 + 追加。
// 只做快操作（不调 LLM、不分类、不合并）；整理交给 consolidator。
import { overlayPaths, emptyState } from './overlay.mjs';
import { sanitizeForStorage } from './redact.mjs';
import {
  AppError,
  appendLine,
  readJson,
  writeJsonAtomic,
  normText,
  sha1,
  nowIso,
  isIsoDate,
  localDateOf
} from './util.mjs';

const KINDS = new Set(['commitment', 'preference', 'fact', 'event', 'decision', 'correction']);
const AGENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const PRUNE_MS = 30 * 24 * 3600 * 1000;

export class Inbox {
  constructor(config, overlay) {
    this.config = config;
    this.overlay = overlay;
    this.paths = overlayPaths(config);
    this._minute = new Map(); // agent -> timestamps
  }

  accept(input) {
    const note = this._validate(input);
    const state = this._loadState();
    this._prune(state);

    // 幂等：idempotency_key 长期有效；同 agent+kind+文本 10 分钟内视为重复
    const idemKey = note.idempotency_key
      ? `k:${note.agent}:${note.idempotency_key}`
      : `h:${note.agent}:${note.kind}:${normText(note.text)}`;
    if (state.idempotency[idemKey]) {
      return { note_id: state.idempotency[idemKey].note_id, deduped: true, replaced: note.replaced };
    }
    const recent = state.recent[idemKey];
    if (recent && Date.now() - Date.parse(recent.ts) < DEDUPE_WINDOW_MS) {
      return { note_id: recent.note_id, deduped: true, replaced: note.replaced };
    }

    this._checkRate(state, note.agent);

    const note_id = `n_${sha1(`${idemKey}|${note.ts}|${Math.random()}`).slice(12)}`;
    const record = {
      schema: 1,
      note_id,
      kind: note.kind,
      text: note.text,
      source: { agent: note.agent, session: note.session, cwd: note.cwd },
      ts: note.ts,
      idempotency_key: note.idempotency_key || null
    };
    appendLine(this.paths.inboxDir + `/${localDateOf(note.ts)}.jsonl`, record);

    state.idempotency[idemKey] = { note_id, ts: note.ts };
    state.recent[idemKey] = { note_id, ts: note.ts };
    const day = localDateOf(note.ts);
    state.daily[day] = state.daily[day] || { global: 0, byAgent: {} };
    state.daily[day].global++;
    state.daily[day].byAgent[note.agent] = (state.daily[day].byAgent[note.agent] || 0) + 1;
    state.updatedAt = nowIso();
    writeJsonAtomic(this.paths.state, state);
    this._minuteFor(note.agent).push(Date.now());

    this.overlay.reload();
    return { note_id, deduped: false, replaced: note.replaced };
  }

  _validate(input) {
    if (!input || typeof input !== 'object') throw new AppError(400, 'BAD_REQUEST', '请求体必须是对象');
    const kind = String(input.kind || '');
    if (!KINDS.has(kind)) {
      throw new AppError(400, 'BAD_REQUEST', `kind 必须是 ${[...KINDS].join('/')}`);
    }
    const text = String(input.text || '').trim();
    if (text.length < 3 || text.length > this.config.maxTextChars) {
      throw new AppError(400, 'BAD_REQUEST', `text 长度必须在 3–${this.config.maxTextChars} 字之间`);
    }
    const src = input.source && typeof input.source === 'object' ? input.source : {};
    const agent = String(src.agent || '');
    if (!AGENT_RE.test(agent)) {
      throw new AppError(400, 'BAD_REQUEST', 'source.agent 必填，且只能是 1–32 位字母/数字/下划线/连字符');
    }
    const session = src.session == null ? null : String(src.session).slice(0, 128);
    const cwd = src.cwd == null ? null : String(src.cwd).slice(0, 256);

    const ts = input.ts ? String(input.ts) : nowIso();
    if (!isIsoDate(ts)) throw new AppError(400, 'BAD_REQUEST', 'ts 必须是 ISO 时间字符串');
    if (Date.parse(ts) > Date.now() + 24 * 3600 * 1000) {
      throw new AppError(400, 'BAD_REQUEST', 'ts 不能超过当前时间 1 天');
    }
    const idempotency_key = input.idempotency_key == null ? null : String(input.idempotency_key).slice(0, 128);
    if (input.idempotency_key != null && idempotency_key.length === 0) {
      throw new AppError(400, 'BAD_REQUEST', 'idempotency_key 不能为空字符串');
    }

    // 高危凭据 → 直接拒绝；PII → 替换
    const { text: safeText, replaced } = sanitizeForStorage(text);
    return { kind, text: safeText, agent, session, cwd, ts, idempotency_key, replaced };
  }

  _loadState() {
    const raw = readJson(this.paths.state, null);
    const state = { ...emptyState(), ...(raw || {}) };
    state.idempotency = state.idempotency || {};
    state.recent = state.recent || {};
    state.daily = state.daily || {};
    state.processedNotes = state.processedNotes || [];
    return state;
  }

  _prune(state) {
    const cutoff = Date.now() - PRUNE_MS;
    for (const [k, v] of Object.entries(state.idempotency)) {
      if (!v || Date.parse(v.ts) < cutoff) delete state.idempotency[k];
    }
    for (const [k, v] of Object.entries(state.recent)) {
      if (!v || Date.parse(v.ts) < cutoff) delete state.recent[k];
    }
    for (const day of Object.keys(state.daily)) {
      if (Date.parse(`${day}T00:00:00Z`) < cutoff) delete state.daily[day];
    }
  }

  _minuteFor(agent) {
    const now = Date.now();
    const arr = (this._minute.get(agent) || []).filter((t) => now - t < 60 * 1000);
    this._minute.set(agent, arr);
    return arr;
  }

  _checkRate(state, agent) {
    const today = localDateOf(nowIso());
    const daily = state.daily[today]?.global || 0;
    if (daily >= this.config.maxPerDay) {
      throw new AppError(429, 'RATE_LIMITED', `今日写入已达上限 ${this.config.maxPerDay} 条`);
    }
    const minute = this._minuteFor(agent);
    if (minute.length >= this.config.maxPerMinute) {
      throw new AppError(429, 'RATE_LIMITED', `单 agent 每分钟写入上限 ${this.config.maxPerMinute} 条`);
    }
  }
}
