// 注入器 build_context(budget=2000)：四段拼装 + 字符上限/估算 token 双闸。
// 预算按字符兜底（CJK 1 字 ≈ 1 token 的最坏情况），估算器只用于展示与二次校验。
import { buildToday } from './today.mjs';
import { recall } from './recall.mjs';
import { cardDay } from './store.mjs';

const BASE_CAPS = { persona: 600, profile: 400, today: 300, recall: 700 };
const MAX_BUDGET = 8000;

export function estTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

function fitText(text, cap) {
  const s = String(text || '');
  if (s.length <= cap) return s;
  return s.slice(0, Math.max(0, cap - 1)) + '…';
}

// 截断时从末尾删行（调用方保证重要内容在前）
function fitLines(lines, cap) {
  const arr = lines.slice();
  while (arr.length > 1 && arr.join('\n').length > cap) arr.pop();
  if (arr.length === 0) return '';
  return fitText(arr.join('\n'), cap);
}

function profileLines(bundle) {
  const profiles = bundle.profiles || [];
  return profiles.map((p) => `- ${p.k}：${p.v}`);
}

function todayLines(state, date) {
  const today = buildToday(state, { date, limit: 5 });
  const lines = [
    `到期 ${today.counts.due} / 逾期 ${today.counts.overdue} / 未完成待办 ${today.counts.pendingOpen} / 今日卡片 ${today.counts.cardsToday}`
  ];
  for (const c of today.overdue) lines.push(`- 逾期 ${c.due_at}：${c.text}`);
  for (const c of today.due) lines.push(`- 到期 ${c.due_at}：${c.text}`);
  for (const c of today.pending) lines.push(`- 待办：${c.text}`);
  for (const c of today.highlights.slice(0, 3)) lines.push(`- 今日要点[${c.type}]：${c.text}`);
  if (today.stale) lines.push('- 数据可能过期（>26h 未更新）');
  return lines;
}

function recallLines(state, q, k) {
  if (!q) {
    const recent = state.docs
      .slice()
      .sort((a, b) => String(b.card.created_at || '').localeCompare(String(a.card.created_at || '')))
      .slice(0, 6);
    return recent.map((doc) => {
      const c = doc.card;
      const topics = (c.topics || []).length ? `｜${(c.topics || []).join('/')}` : '';
      return `- [${c.type}|${cardDay(c)}${topics}] ${c.text}`;
    });
  }
  const result = recall(state, { q, k });
  if (result.items.length === 0) return [];
  return result.items.map((it) => {
    const topics = it.topics.length ? `｜${it.topics.join('/')}` : '';
    return `- [${it.type}|${it.day}${topics}] ${it.text}`;
  });
}

/**
 * 生成可注入上下文的文本。
 * @returns {{text:string, chars:number, estTokens:number, budget:number,
 *            sections:Array<{name:string, chars:number, estTokens:number}>, hits:number}}
 */
export function buildContext(state, { q = '', budget = 2000, date } = {}) {
  const limit = Math.min(MAX_BUDGET, Math.max(200, Math.trunc(Number(budget) || 2000)));
  const scale = Math.min(2, Math.max(0.2, limit / 2000));
  const caps = Object.fromEntries(
    Object.entries(BASE_CAPS).map(([k, v]) => [k, Math.max(40, Math.round(v * scale))])
  );

  const personaText = fitText(state.bundle.persona?.content || '', caps.persona);
  let profileText = fitLines(profileLines(state.bundle), caps.profile);
  let todayText = fitLines(todayLines(state, date), caps.today);
  const recallList = recallLines(state, q, 8);
  let recallText = fitLines(recallList, caps.recall);
  const hits = q ? recall(state, { q, k: 8 }).total : recallList.length;

  const section = (name, body) => ({
    name,
    chars: body.length,
    estTokens: estTokens(body)
  });

  // 区分"确实没有命中"与"命中但被预算裁光"，避免给模型自相矛盾的信息
  const recallBody = () =>
    recallText || (hits > 0 ? `（预算不足，省略 ${hits} 条相关记忆）` : '（无匹配记忆）');

  const render = () => {
    const parts = [
      ['人设', personaText],
      ['画像', profileText],
      ['今天', todayText],
      ['相关记忆', recallBody()]
    ];
    return {
      text: parts.map(([title, body]) => `## ${title}\n${body}`).join('\n'),
      sections: parts.map(([title, body]) => section(title, body))
    };
  };

  let out = render();
  // 双闸：估算 token 未超但字符也要守（tokenizer 差异兜底）；反之亦然
  let guard = 0;
  while ((out.text.length > limit || estTokens(out.text) > limit) && guard++ < 200) {
    if (recallText) {
      recallText = trimOneLine(recallText) || '';
    } else if (todayText) {
      todayText = trimOneLine(todayText) || '';
    } else if (profileText) {
      profileText = trimOneLine(profileText) || '';
    } else {
      break;
    }
    out = render();
  }

  return {
    text: out.text,
    chars: out.text.length,
    estTokens: estTokens(out.text),
    budget: limit,
    sections: out.sections,
    hits
  };
}

function trimOneLine(text) {
  const lines = text.split('\n');
  lines.pop();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
