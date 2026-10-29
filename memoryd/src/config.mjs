// memoryd 配置：路径、端口、预算。CLI 与 env 覆盖，不建配置文件。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PKG = { name: 'memoryd', version: '0.1.0' };

// memoryd/src -> 仓库根
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 7788,
  budget: 2000,
  k: 8,
  consolidateMs: 120000,
  maxPerDay: 200,
  maxPerMinute: 30,
  maxTextChars: 500,
  remindMs: 1800000,
  remindNotify: false,
  remindQuietStart: 22,
  remindQuietEnd: 8,
  remindDailyNotifyMax: 5
};

/**
 * 由 CLI flags（和 env）得到运行配置。
 * 环境变量：MEMORYD_HOST / MEMORYD_PORT / MEMORYD_ROOT
 */
export function resolveConfig(flags = {}) {
  const root = String(flags.root || process.env.MEMORYD_ROOT || REPO_ROOT);
  return {
    root,
    host: String(flags.host || process.env.MEMORYD_HOST || DEFAULTS.host),
    port: toInt(flags.port ?? process.env.MEMORYD_PORT, DEFAULTS.port, 1, 65535),
    budget: toInt(flags.budget, DEFAULTS.budget, 200, 8000),
    k: toInt(flags.k, DEFAULTS.k, 1, 50),
    consolidateMs: toInt(flags['consolidate-ms'] ?? process.env.MEMORYD_CONSOLIDATE_MS, DEFAULTS.consolidateMs, 5000, 3600000),
    maxPerDay: toInt(flags['max-per-day'] ?? process.env.MEMORYD_MAX_PER_DAY, DEFAULTS.maxPerDay, 1, 10000),
    maxPerMinute: toInt(flags['max-per-minute'] ?? process.env.MEMORYD_MAX_PER_MINUTE, DEFAULTS.maxPerMinute, 1, 1000),
    maxTextChars: toInt(flags['max-text-chars'] ?? process.env.MEMORYD_MAX_TEXT_CHARS, DEFAULTS.maxTextChars, 20, 2000),
    remindMs: toInt(flags['remind-ms'] ?? process.env.MEMORYD_REMIND_MS, DEFAULTS.remindMs, 60000, 86400000),
    remindNotify:
      flags.notify === true || process.env.MEMORYD_NOTIFY === '1' || flags.notify === 'true',
    remindQuietStart: toInt(flags['quiet-start'] ?? process.env.MEMORYD_QUIET_START, DEFAULTS.remindQuietStart, 0, 23),
    remindQuietEnd: toInt(flags['quiet-end'] ?? process.env.MEMORYD_QUIET_END, DEFAULTS.remindQuietEnd, 0, 23),
    remindDailyNotifyMax: toInt(
      flags['max-notify'] ?? process.env.MEMORYD_MAX_NOTIFY,
      DEFAULTS.remindDailyNotifyMax,
      0,
      100
    ),
    dataDir: path.join(root, 'memory-ingest', 'data'),
    memoryDir: path.join(root, 'memory-ingest', 'memory'),
    uiDir: path.join(root, 'memory-galaxy'),
    outDir: path.join(root, 'memoryd', 'data')
  };
}

function toInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 极简参数解析：`sub --key value --flag`，`--key=value` 也支持。 */
export function parseArgs(argv = []) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[key] = next;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
