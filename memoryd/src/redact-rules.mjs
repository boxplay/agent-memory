// 脱敏规则（规范来源）：memoryd 与 memory-ingest 共用。
// 改这里会影响两个入口，必须跑 memoryd/test/api-parity（见各 REPORT）。
export const RULES = [
  { kind: 'api_key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{10,}/gi },
  { kind: 'password', re: /(密码|password|passwd)\s*[:：=]?\s*\S{3,40}/gi },
  { kind: 'token', re: /\btoken\b[^。；\n]{0,40}/gi },
  { kind: 'ip_internal', re: /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}\b/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'phone', re: /\b1[3-9]\d{9}\b/g }
];

/**
 * 替换一段文本里的敏感串。
 * @returns {{text:string, hits:number, kinds:string[]}} hits 按规则命中次数计，kinds 去重后的命中类型
 */
export function redactText(input) {
  let text = String(input || '').replace(/\[REDACTED:[a-z_]+\]/g, '[已脱敏]');
  let hits = 0;
  const kinds = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, () => {
      hits++;
      kinds.add(rule.kind);
      return '[已脱敏]';
    });
  }
  return { text, hits, kinds: [...kinds] };
}

