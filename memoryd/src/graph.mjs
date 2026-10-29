// /graph 与 /data.js 的合并 bundle：基座 bundle 的页面结构 + agent 卡。
// 结构与 memory-ingest/tools/build-graph.mjs 保持一致（day/card/commitment 形状），
// 额外给 agent 卡加 agent:true 标记，前端忽略未知字段。
import crypto from 'node:crypto';
import { cardDay } from './store.mjs';

const TYPE_KEEP = new Set(['decision', 'preference', 'correction']);
const CAT_LABEL = { work: '工作', daily: '日常' };

function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[#>*\-\s|]+/, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function short(t, n = 16) {
  const s = clean(t);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sortCards(a, b) {
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

/** 由合并视图（view.cards）生成页面 bundle。 */
export function buildMergedBundle(view) {
  const cards = view.cards || [];
  const base = view.bundle || {};

  const dayMap = new Map();
  for (const c of cards) {
    const day = cardDay(c);
    if (!day) continue;
    const cat = c.cat === 'daily' ? 'daily' : 'work';
    const key = `${day}|${cat}`;
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(c);
  }

  const days = [];
  for (const [key, list] of [...dayMap.entries()].sort()) {
    const [date, cat] = key.split('|');
    list.sort(sortCards);
    const outCards = list.map((c) => {
      const t = TYPE_KEEP.has(c.type) ? c.type : 'event';
      const out = {
        id: c.id,
        t,
        text: clean(c.text),
        cat,
        topics: c.topics || [],
        entities: c.entities || [],
        quote: clean(c.quote || ''),
        source: c.source || null,
        confidence: c.confidence ?? null,
        status: c.status ?? null
      };
      if (c.type === 'commitment') out.reminds = 'cm_' + c.id;
      if (c.source?.kind === 'agent') out.agent = true;
      if (c.pinned) out.pinned = true;
      return out;
    });
    const kinds = list.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {});
    const summary =
      `${CAT_LABEL[cat]} · ${list.length} 条（` +
      Object.entries(kinds)
        .map(([k, v]) => `${k} ${v}`)
        .join('，') +
      '）';
    days.push({ date, summary, cards: outCards });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));

  const commitments = cards
    .filter((c) => c.type === 'commitment')
    .map((c) => ({
      id: 'cm_' + c.id,
      text: clean(c.text),
      short: short(c.text, 10),
      due: c.due_at || '',
      status: c.status || 'pending',
      fromDay: cardDay(c),
      cat: c.cat === 'daily' ? 'daily' : 'work',
      quote: clean(c.quote || ''),
      source: c.source || null,
      confidence: c.confidence ?? null,
      ...(c.pinned ? { pinned: true } : {})
    }));

  const topicSet = new Set();
  const entitySet = new Set();
  for (const c of cards) {
    for (const t of c.topics || []) topicSet.add(t);
    for (const e of c.entities || []) entitySet.add(e);
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'memoryd (base + agent overlay)',
    persona: base.persona || {},
    profiles: base.profiles || [],
    topics: [...topicSet],
    entities: [...entitySet],
    days,
    commitments,
    segments: base.segments || [],
    artifacts: base.artifacts || []
  };
}

export function bundleEtag(bundle) {
  // generatedAt 每次生成都变，不参与哈希，否则合并 bundle 的 ETag 永远无法命中 304
  const { generatedAt, ...rest } = bundle;
  return `W/"merge-${crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12)}"`;
}
