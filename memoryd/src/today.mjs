// /today：今天到期、逾期、未完成待办、今日要点。
// 口径写死在这里，README 同步说明；数据本身稀疏（due_at 少）不是 bug。
import { cardDay, isStale } from './store.mjs';
import { localDate } from './query.mjs';

const HIGHLIGHT_RANK = {
  decision: 0,
  preference: 1,
  correction: 2,
  event: 3,
  fact: 4,
  commitment: 5
};

const commitmentOut = (card) => ({
  id: card.id,
  text: card.text,
  due_at: card.due_at || null,
  status: card.status || null,
  cat: card.cat || 'work',
  day: cardDay(card)
});

const cardOut = (card) => ({
  id: card.id,
  day: cardDay(card),
  type: card.type,
  cat: card.cat || 'work',
  text: card.text,
  topics: card.topics || []
});

export function buildToday(state, { date, limit = 5 } = {}) {
  const day = date || localDate();
  const max = Math.min(20, Math.max(1, Math.trunc(Number(limit) || 5)));

  const due = [];
  const overdue = [];
  const pending = [];
  const todayCards = [];

  for (const card of state.cards) {
    if (card.type === 'commitment' && (card.status || 'pending') === 'pending') {
      const dueAt = card.due_at ? String(card.due_at).slice(0, 10) : '';
      if (dueAt && dueAt === day) due.push(card);
      else if (dueAt && dueAt < day) overdue.push(card);
      else if (!dueAt) pending.push(card);
    }
    if (cardDay(card) === day) todayCards.push(card);
  }

  due.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  overdue.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const pinFirst = (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    String(b.created_at || '').localeCompare(String(a.created_at || ''));
  pending.sort(pinFirst);

  const highlights = todayCards
    .slice()
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (HIGHLIGHT_RANK[a.type] ?? 9) - (HIGHLIGHT_RANK[b.type] ?? 9) ||
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
    )
    .slice(0, max)
    .map(cardOut);

  return {
    date: day,
    due: due.slice(0, max).map(commitmentOut),
    overdue: overdue.slice(0, max).map(commitmentOut),
    pending: pending.slice(0, max).map(commitmentOut),
    highlights,
    counts: {
      due: due.length,
      overdue: overdue.length,
      pendingOpen: pending.length,
      cardsToday: todayCards.length,
      cardsTotal: state.cards.length
    },
    stale: isStale(state)
  };
}

export function renderToday(data) {
  const lines = [
    `## 今天（${data.date}）`,
    `到期 ${data.counts.due} / 逾期 ${data.counts.overdue} / 未完成待办 ${data.counts.pendingOpen} / 今日卡片 ${data.counts.cardsToday}`
  ];
  for (const c of data.overdue) lines.push(`- 逾期 ${c.due_at}：${c.text}`);
  for (const c of data.due) lines.push(`- 到期 ${c.due_at}：${c.text}`);
  for (const c of data.pending) lines.push(`- 待办：${c.text}`);
  if (data.highlights.length) {
    lines.push('### 今日要点');
    for (const c of data.highlights) lines.push(`- [${c.type}] ${c.text}`);
  }
  if (data.stale) lines.push('（注意：记忆数据超过 26 小时未更新，可能是每日增量失败）');
  return lines.join('\n');
}
