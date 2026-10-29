// 查询理解：日期表达式、意图映射、主题/实体识别、分词与停用词。
// 纯函数，不依赖数据文件；时间一律用本地时区（与 launchd/用户感知一致）。

export const DAY_MS = 86400000;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD。 */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toUtcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 日期字符串加减天数（按日历日，不受时区影响）。 */
export function addDays(dateStr, n) {
  const d = new Date(toUtcMs(dateStr) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 严格校验日历日期（拒 2026-02-30 / 2026-13-01）。 */
export function isValidDate(dateStr) {
  const s = String(dateStr || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const RELATIVE = [
  ['今天', 0],
  ['今日', 0],
  ['昨天', -1],
  ['昨日', -1],
  ['前天', -2],
  ['明天', 1]
];

/**
 * 从问题里解析日期范围。返回 {from,to} 或 null。
 * 支持：今天/昨天/前天/明天、YYYY-MM-DD、YYYY年M月D日、M月D日、本周、上周、最近N天。
 */
export function parseDateQuery(q, nowMs = Date.now()) {
  const text = String(q || '');
  const today = localDate(new Date(nowMs));

  for (const [word, delta] of RELATIVE) {
    if (text.includes(word)) {
      const day = addDays(today, delta);
      return { from: day, to: day };
    }
  }

  let m = text.match(/(\d{4})\s*[-\/年]\s*(\d{1,2})\s*[-\/月]\s*(\d{1,2})/);
  if (m) {
    const day = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    if (isValidDate(day)) return { from: day, to: day };
  }

  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const year = Number(today.slice(0, 4));
    const day = `${year}-${pad2(m[1])}-${pad2(m[2])}`;
    if (isValidDate(day)) return { from: day, to: day };
  }

  m = text.match(/最近\s*(\d+)\s*天/);
  if (m) {
    const n = Math.min(365, Math.max(1, Number(m[1])));
    return { from: addDays(today, -(n - 1)), to: today };
  }

  const weekStart = (offsetWeeks) => {
    const dow = (new Date(toUtcMs(today)).getUTCDay() + 6) % 7; // 周一=0
    const thisMonday = addDays(today, -dow);
    const from = addDays(thisMonday, offsetWeeks * 7);
    const to = offsetWeeks === 0 ? today : addDays(from, 6);
    return { from, to };
  };
  if (text.includes('上周')) return weekStart(-1);
  if (text.includes('本周') || text.includes('这周')) return weekStart(0);

  return null;
}

/** 去掉查询里的日期词，避免它们污染关键词匹配。 */
export function stripDateExpr(q) {
  return String(q || '')
    .replace(/\d{4}\s*[-\/年]\s*\d{1,2}\s*[-\/月]\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/今天|今日|昨天|昨日|前天|明天|本周|这周|上周|最近\s*\d+\s*天/g, ' ');
}

// 疑问/指代/虚词/元词：参与检索只会导致"过滤对了却命中 0 条"
const STOP_PATTERN =
  /(我|你|他|她|它|我们|你们|的|了|吗|呢|吧|啊|是|有|没有|哪些|什么|怎么|为什么|如何|多少|几个|做了|做|发生|事情|一下|告诉|记得|回忆|之前|上次|那次|相关|关于|方面|上|里|中|还|都|要|想|请|帮我|查|找|看看|是否|有没有|可以|能|给|和|与|及|或|在|记录|记忆|历史|内容|资料|东西)/g;

export function stripFillers(q) {
  return String(q || '').replace(STOP_PATTERN, ' ');
}

/** 关键词：拉丁/数字词 + 中文 bigram（丢弃单字，效果优于单字噪声）。 */
export function qTerms(q) {
  const text = String(q || '');
  const out = new Set();
  for (const t of text.toLowerCase().match(/[a-z0-9][a-z0-9_\-./]*/g) || []) {
    if (t.length >= 2) out.add(t);
  }
  for (const seg of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 意图 → 卡片类型（可能带状态）。顺序即优先级。 */
export const INTENTS = [
  {
    type: 'commitment',
    status: 'pending',
    words: [
      '待办', '还没', '没做', '没做完', '做完', '未完成', '要做', '承诺', '答应',
      '记得提醒', '别忘了', 'todo', '待做', '任务', '待修', '要修', '需要修'
    ]
  },
  { type: 'preference', words: ['偏好', '喜欢', '习惯', '风格', '口味', '倾向', '不要'] },
  { type: 'decision', words: ['决定', '拍板', '定了', '确定用', '选了'] },
  { type: 'correction', words: ['更正', '改主意', '不是这样', '说错', '纠正'] },
  { type: 'fact', words: ['是什么', '叫什么', '身份', '信息'] }
];

export function detectIntent(q) {
  const text = String(q || '').toLowerCase();
  for (const intent of INTENTS) {
    if (intent.words.some((w) => text.includes(w))) return intent;
  }
  return null;
}

/** 查询里明确出现的主题/实体名（大小写不敏感）。 */
export function detectNames(q, names = []) {
  const text = String(q || '').toLowerCase();
  return names.filter((n) => n && text.includes(String(n).toLowerCase()));
}
