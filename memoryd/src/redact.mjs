// memoryd 的脱敏封装：规则规范来源在 ./redact-rules.mjs（memory-ingest/tools/redact.mjs 反向引用同一份），
// 避免第三份重复规则（历史教训见 REPORT-W1 §8）。
import { RULES, redactText } from './redact-rules.mjs';
import { AppError } from './util.mjs';

// 高危：直接拒绝入库（不存原文）
export const HIGH_RISK_KINDS = new Set(['api_key', 'bearer', 'password', 'token']);
// 一般 PII：替换后允许入库
export const PII_KINDS = new Set(['ip_internal', 'email', 'phone']);

/** 扫描文本里的敏感命中类型（按规则去重）。 */
export function scan(text) {
  const hits = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(String(text || ''))) hits.add(rule.kind);
  }
  return [...hits];
}

/**
 * 写入前处理：高危命中 → 抛 400 SECRET_REJECTED；PII → 替换。
 * 返回 { text, replaced }。
 */
export function sanitizeForStorage(text) {
  const kinds = scan(text);
  const high = kinds.filter((k) => HIGH_RISK_KINDS.has(k));
  if (high.length > 0) {
    throw new AppError(400, 'SECRET_REJECTED', `内容疑似包含凭据（${high.join('/')}），已拒绝入库；请先脱敏再写入`);
  }
  const result = redactText(text);
  return { text: result.text, replaced: result.hits > 0 };
}
