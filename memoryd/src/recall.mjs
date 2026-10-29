// 混合检索：结构化过滤（日期/主题/实体/类型/分类）+ BM25-lite 关键词排序。
// 关键设计：结构化条件命中后若关键词 0 命中，降级为按时间倒序，绝不返回"过滤对了却空"。
import {
  parseDateQuery,
  stripDateExpr,
  stripFillers,
  qTerms,
  detectIntent,
  detectNames,
  isValidDate
} from './query.mjs';
import { cardDay, round2 } from './store.mjs';

const K1 = 1.2;
const B = 0.75;
const MAX_Q = 500;
// 内容词覆盖门槛：只命中一个常见词（如"结果"）不算相关，避免无关问题返回似是而非的卡片
const MIN_COVERAGE = 0.35;
const CARD_TYPES = ['fact', 'decision', 'event', 'commitment', 'preference', 'correction'];
const CATS = ['work', 'daily'];

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'BAD_REQUEST';
  }
}

const lower = (s) => String(s || '').toLowerCase();

function termFreq(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function docFreq(state, term) {
  if (!state.dfCache.has(term)) {
    let n = 0;
    for (const doc of state.docs) {
      if (doc.text.includes(term) || doc.topics.includes(term) || doc.ents.includes(term)) n++;
    }
    state.dfCache.set(term, n);
  }
  return state.dfCache.get(term);
}

function idf(state, term) {
  const df = docFreq(state, term);
  return Math.log(1 + (state.docs.length - df + 0.5) / (df + 0.5));
}

function bm25(state, doc, terms) {
  let score = 0;
  for (const term of terms) {
    const ft = termFreq(doc.text, term);
    const fm = Math.max(termFreq(doc.topics, term), termFreq(doc.ents, term));
    const norm = K1 * (1 - B + (B * doc.len) / state.avgdl);
    if (ft) score += (idf(state, term) * (ft * (K1 + 1))) / (ft + norm);
    if (fm) score += (idf(state, term) * (fm * (K1 + 1))) / (fm + norm) * 0.5;
  }
  return score;
}

// 短语证据：返回命中的最长连续片段长度。覆盖率按"命中片段长度 / 内容查询长度"算，
// 避免查询里只有一个词（如"芯片"）命中就把整句当成命中（空格切词不能绕过门槛）。
function phraseEvidence(doc, contentQ) {
  const normalized = lower(contentQ).replace(/\s+/g, '');
  if (normalized.length >= 2 && doc.text.includes(normalized)) {
    return { chars: normalized.length, boost: 3 };
  }
  let longest = 0;
  for (const run of String(contentQ).match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (doc.text.includes(lower(run)) && run.length > longest) longest = run.length;
  }
  return { chars: longest, boost: longest >= 2 ? 2 : 0 };
}

function item(doc, score, includeSource) {
  const c = doc.card;
  const out = {
    id: c.id,
    day: cardDay(c),
    type: c.type,
    cat: c.cat || 'work',
    text: c.text,
    topics: c.topics || [],
    entities: c.entities || [],
    due_at: c.due_at || null,
    status: c.status || null,
    pinned: Boolean(c.pinned),
    score: round2(score)
  };
  if (includeSource && c.source) {
    out.source = { kind: c.source.kind, project: c.source.project, turn: c.source.turn };
  }
  return out;
}

function normalizeInput(opts = {}) {
  const q = String(opts.q || '').slice(0, MAX_Q);
  for (const key of ['from', 'to']) {
    const v = opts[key];
    if (v && !isValidDate(v)) {
      throw new BadRequest(`${key} 必须是合法的 YYYY-MM-DD 日期，收到：${v}`);
    }
  }
  if (opts.type && !CARD_TYPES.includes(opts.type)) {
    throw new BadRequest(`type 必须是 ${CARD_TYPES.join('/')}`);
  }
  if (opts.cat && !CATS.includes(opts.cat)) {
    throw new BadRequest(`cat 必须是 ${CATS.join('/')}`);
  }
  const k = Math.min(50, Math.max(1, Math.trunc(Number(opts.k) || 8)));
  return {
    q,
    from: opts.from || null,
    to: opts.to || null,
    topic: opts.topic || null,
    entity: opts.entity || null,
    type: opts.type || null,
    cat: opts.cat || null,
    k,
    includeSource: Boolean(opts.includeSource),
    nowMs: opts.nowMs || Date.now()
  };
}

/**
 * 检索入口。返回 {total, items, understood}。
 * understood 里带日期/意图/主题识别的结果，便于调试与评测。
 */
export function recall(state, rawOpts = {}) {
  const input = normalizeInput(rawOpts);
  const dateRange = parseDateQuery(input.q, input.nowMs);
  const intent = detectIntent(input.q);
  const autoTopics = detectNames(input.q, state.topicNames);
  const autoEntities = detectNames(input.q, state.entityNames);

  const from = input.from || dateRange?.from || null;
  const to = input.to || dateRange?.to || null;
  const topics = input.topic ? [input.topic] : autoTopics;
  const entities = input.entity ? [input.entity] : autoEntities;
  const type = input.type || intent?.type || null;
  const status = input.type ? null : intent?.status || null;
  const cat = input.cat;

  const byDate = (doc) => {
    const day = cardDay(doc.card);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };
  const byCat = (doc) => !cat || (doc.card.cat || 'work') === cat;
  const byType = (doc) => !type || doc.card.type === type;
  const byStatus = (doc) => !status || (doc.card.status || '') === status;
  const byTopics = (doc) =>
    topics.length === 0 ||
    topics.some((t) => (doc.card.topics || []).some((x) => lower(x) === lower(t)));
  const byEntities = (doc) =>
    entities.length === 0 ||
    entities.some((e) => (doc.card.entities || []).some((x) => lower(x) === lower(e)));

  // 渐进放宽：先全条件，再逐级去掉较弱条件，避免"条件对但结果空"
  const levels = [
    (d) => byDate(d) && byCat(d) && byType(d) && byStatus(d) && byTopics(d) && byEntities(d),
    (d) => byDate(d) && byCat(d) && byType(d) && byTopics(d) && byEntities(d),
    (d) => byDate(d) && byCat(d) && byTopics(d) && byEntities(d),
    (d) => byDate(d) && byCat(d),
    (d) => byCat(d)
  ];
  let pool = [];
  let relaxed = 0;
  for (let i = 0; i < levels.length; i++) {
    pool = state.docs.filter(levels[i]);
    if (pool.length > 0) {
      relaxed = i;
      break;
    }
  }

  const terms = qTerms(contentQuery(input.q, intent, autoTopics, autoEntities));
  const contentQ = contentQuery(input.q, intent, autoTopics, autoEntities);
  const rank = (candidates) => {
    const idfMap = new Map(terms.map((t) => [t, idf(state, t)]));
    const totalWeight = terms.reduce((sum, t) => sum + idfMap.get(t), 0) || 1;
    const contentChars = Math.max(1, lower(contentQ).replace(/\s+/g, '').length);
    return candidates
      .map((doc) => {
        const evidence = phraseEvidence(doc, contentQ);
        let matchedWeight = 0;
        for (const term of terms) {
          if (doc.text.includes(term) || doc.topics.includes(term) || doc.ents.includes(term)) {
            matchedWeight += idfMap.get(term);
          }
        }
        return {
          doc,
          score: bm25(state, doc, terms) + evidence.boost + (doc.card.pinned ? 5 : 0),
          // 相关性 = max(命中词权重覆盖, 命中连续片段长度/查询长度)；
          // 只命中一个常见词或长句里的一个短词都不算相关
          coverage: Math.max(matchedWeight / totalWeight, evidence.chars / contentChars)
        };
      })
      .filter((x) => x.coverage >= MIN_COVERAGE)
      .sort((a, b) => b.score - a.score || byRecency(a.doc, b.doc));
  };

  let ranked = terms.length > 0 ? rank(pool) : [];

  // 意图词（如"决定/偏好"）可能误伤内容关键词查询：严格池无命中时，去掉意图类型再试一次。
  if (ranked.length === 0 && terms.length > 0 && type && !input.type) {
    const relaxedPool = state.docs.filter((d) => byDate(d) && byCat(d) && byTopics(d) && byEntities(d));
    ranked = rank(relaxedPool);
  }

  // 纯意图/纯日期/纯实体查询（没有内容关键词）→ 结构化结果按时间倒序；
  // 有日期/主题/实体这类强结构线索时，即使内容词没命中也可回退（仍限定在该结构内）；
  // 只有意图（如"偏好"）且关键词 0 命中时必须返回空，不能拿无关卡片冒充相关记忆。
  const strongStructure = Boolean(from || to || topics.length || entities.length);
  if (ranked.length === 0 && relaxed === 0 && pool.length > 0 && (terms.length === 0 || strongStructure)) {
    ranked = pool
      .map((doc) => ({ doc, score: 0 }))
      .sort((a, b) => byRecency(a.doc, b.doc));
  }

  return {
    total: ranked.length,
    items: ranked.slice(0, input.k).map((x) => item(x.doc, x.score, input.includeSource)),
    understood: {
      from,
      to,
      type,
      status,
      topics,
      entities,
      cat,
      terms,
      relaxedLevel: relaxed
    }
  };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 去掉日期、意图词、已识别主题/实体名后的"内容关键词"，避免它们把结构化查询带偏
function contentQuery(q, intent, topics, entities) {
  let text = stripDateExpr(q);
  const removals = [...(intent?.words || []), ...topics, ...entities].filter(Boolean);
  for (const word of removals) {
    text = text.replace(new RegExp(escapeRegExp(String(word)), 'gi'), ' ');
  }
  return stripFillers(text);
}

function byRecency(a, b) {
  return String(b.card.created_at || '').localeCompare(String(a.card.created_at || ''));
}

/** 给 MCP/CLI 渲染的紧凑文本。 */
export function renderRecall(result, input = {}) {
  const head = [];
  if (input.q) head.push(`q=${input.q}`);
  if (input.from || input.to) head.push(`范围=${input.from || '…'}~${input.to || '…'}`);
  if (input.topic) head.push(`主题=${input.topic}`);
  if (input.entity) head.push(`实体=${input.entity}`);
  if (input.type) head.push(`类型=${input.type}`);
  if (result.understood?.from && !input.from) head.push(`识别日期=${result.understood.from}`);
  if (result.understood?.type && !input.type) head.push(`识别类型=${result.understood.type}`);
  const scope = head.length ? `（${head.join('，')}）` : '';
  if (result.items.length === 0) {
    return `未找到匹配记忆${scope}。本地没有相关记录，不要编造；可以换个关键词或给日期范围再查。`;
  }
  const lines = [`共 ${result.total} 条${scope}：`];
  result.items.forEach((it, i) => {
    const topics = it.topics.length ? `｜${it.topics.join('/')}` : '';
    lines.push(`${i + 1}. [${it.type}|${it.day}${topics}] ${it.text}（id ${it.id}）`);
  });
  if (result.total > result.items.length) lines.push(`（仅显示前 ${result.items.length} 条，可调大 k）`);
  return lines.join('\n');
}
