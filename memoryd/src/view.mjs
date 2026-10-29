// 读视图：基座 cards + overlay（agent 卡 / 墓碑 / done / pin）合并成一份索引态。
// /recall /today /context 用合并视图；include_agent=0 时只保留基座卡（但用户对基座卡的 forget/done 仍生效）。
import { indexCards } from './store.mjs';
import { normText } from './util.mjs';

export function mergeCards(baseCards, overlay, { includeAgent = true } = {}) {
  const baseKeys = new Set();
  for (const c of baseCards) baseKeys.add(`${c.type}|${normText(c.text)}`);

  const decorate = (card) => {
    const done = overlay.doneIds.has(card.id);
    const pinned = overlay.pinnedIds.has(card.id);
    if (!done && !pinned) return card;
    return { ...card, ...(done ? { status: 'done' } : {}), ...(pinned ? { pinned: true } : {}) };
  };

  const out = [];
  for (const card of baseCards) {
    if (overlay.hiddenCardIds.has(card.id)) continue;
    out.push(decorate(card));
  }
  if (!includeAgent) return out;

  for (const card of overlay.agentCards) {
    if (overlay.hiddenCardIds.has(card.id)) continue;
    const noteId = card.source?.note_id;
    if (noteId && overlay.hiddenNoteIds.has(noteId)) continue;
    // 基座优先：同一 type+归一化文本已在基座出现时，不再重复展示 agent 卡
    if (baseKeys.has(`${card.type}|${normText(card.text)}`)) continue;
    out.push(decorate(card));
  }
  return out;
}

export class ViewManager {
  constructor(store, overlay) {
    this.store = store;
    this.overlay = overlay;
    this.cache = null;
    this.cacheSig = null;
    this.baseCache = null;
    this.baseCacheSig = null;
  }

  base() {
    this.store.maybeReload();
    return this.store.get();
  }

  get() {
    const base = this.base();
    this.overlay.maybeReload();
    const ov = this.overlay.get();
    const sig = `${base.sig}|${ov.sig}`;
    if (this.cache && this.cacheSig === sig) return this.cache;
    const cards = mergeCards(base.cards, ov, { includeAgent: true });
    const baseVisible = base.cards.filter((c) => !ov.hiddenCardIds.has(c.id)).length;
    this.cache = {
      ...base,
      ...indexCards(cards),
      cards,
      bundle: base.bundle,
      overlayMeta: this.overlay.meta(),
      viewMeta: {
        baseVisible,
        agentVisible: cards.length - baseVisible,
        // 卡片级写回（done/pin/forget）数量：有则页面 bundle 需并入 overlay 状态回显
        cardFeedback: ov.doneIds.size + ov.pinnedIds.size + ov.hiddenCardIds.size
      }
    };
    this.cacheSig = sig;
    return this.cache;
  }

  getBaseOnly() {
    const base = this.base();
    this.overlay.maybeReload();
    const ov = this.overlay.get();
    const sig = `base-only|${base.sig}|${ov.sig}`;
    if (this.baseCache && this.baseCacheSig === sig) return this.baseCache;
    const cards = mergeCards(base.cards, ov, { includeAgent: false });
    this.baseCache = {
      ...base,
      ...indexCards(cards),
      cards,
      bundle: base.bundle,
      overlayMeta: this.overlay.meta(),
      viewMeta: { baseVisible: cards.length, agentVisible: 0 }
    };
    this.baseCacheSig = sig;
    return this.baseCache;
  }
}
