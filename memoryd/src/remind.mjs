// W3a 提醒引擎：扫描 pending 承诺的 overdue / today due，写提醒队列（可选 macOS 通知）。
// 默认只写队列；静默时段 22–08 不弹通知；每日通知上限；同卡当天只提醒一次。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { overlayPaths, emptyState } from './overlay.mjs';
import { readJson, readJsonl, writeJsonAtomic, appendLine, sha1, nowIso, localDateOf } from './util.mjs';

const PRUNE_DAYS = 7;

export function remindersDir(config) {
  return path.join(config.outDir, 'reminders');
}

export function remindersFile(config, date) {
  return path.join(remindersDir(config), `${date}.jsonl`);
}

export function isQuiet(now, start, end) {
  const h = now.getHours();
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

export function notifyMac(title, body) {
  if (process.platform !== 'darwin') return false;
  const script = `display notification ${JSON.stringify(String(body).slice(0, 120))} with title ${JSON.stringify(title)}`;
  const r = spawnSync('/usr/bin/osascript', ['-e', script], { timeout: 5000 });
  return r.status === 0;
}

function collect(state, today) {
  const overdue = [];
  const due = [];
  let pendingOpen = 0;
  for (const card of state.cards) {
    if (card.type !== 'commitment') continue;
    if ((card.status || 'pending') !== 'pending') continue;
    const dueAt = card.due_at ? String(card.due_at).slice(0, 10) : '';
    if (!dueAt) {
      pendingOpen++;
      continue;
    }
    if (dueAt < today) overdue.push(card);
    else if (dueAt === today) due.push(card);
  }
  const byDue = (a, b) => String(a.due_at).localeCompare(String(b.due_at));
  overdue.sort(byDue);
  due.sort(byDue);
  return { overdue, due, pendingOpen };
}

/**
 * 跑一次提醒扫描。
 * @param {{store:object,overlay:object,view:object,config:object}} ctx
 * @param {{now?:Date, dryRun?:boolean, notify?:boolean, notifyImpl?:Function,
 *          quietStart?:number, quietEnd?:number, dailyNotifyMax?:number}} opts
 */
export function runRemind(ctx, opts = {}) {
  const { store, overlay, view, config } = ctx;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const quietStart = opts.quietStart ?? config.remindQuietStart;
  const quietEnd = opts.quietEnd ?? config.remindQuietEnd;
  const maxNotify = opts.dailyNotifyMax ?? config.remindDailyNotifyMax;
  const notify = opts.notify === undefined ? Boolean(config.remindNotify) : Boolean(opts.notify);
  const notifyImpl = opts.notifyImpl || notifyMac;
  const dryRun = Boolean(opts.dryRun);

  store.maybeReload();
  overlay.reload();
  const state = view.get();
  const today = localDateOf(now);

  const paths = overlayPaths(config);
  const st = { ...emptyState(), ...readJson(paths.state, {}) };
  st.reminders = st.reminders || { lastRunAt: null, daily: {} };
  st.reminders.daily = st.reminders.daily || {};
  const day = st.reminders.daily[today] || { seen: [], notified: 0, digest: false };
  const seen = new Set(day.seen);

  const { overdue, due, pendingOpen } = collect(state, today);
  const quiet = isQuiet(now, quietStart, quietEnd);
  const records = [];

  if (!day.digest) {
    records.push({
      reminder_id: `rm_digest_${today}`,
      date: today,
      kind: 'digest',
      due_at: null,
      card_id: null,
      text: `今日到期 ${due.length} 条 · 逾期 ${overdue.length} 条 · 未完成待办 ${pendingOpen} 条`,
      created_at: nowIso(),
      notified: false,
      channel: 'queue'
    });
  }
  for (const card of [...overdue, ...due]) {
    if (seen.has(card.id)) continue;
    const dueAt = String(card.due_at).slice(0, 10);
    records.push({
      reminder_id: `rm_${sha1(`${today}|${card.id}`).slice(12)}`,
      date: today,
      kind: dueAt < today ? 'overdue' : 'due_today',
      due_at: dueAt,
      card_id: card.id,
      text: card.text,
      created_at: nowIso(),
      notified: false,
      channel: 'queue'
    });
    seen.add(card.id);
  }

  if (dryRun) {
    return {
      dryRun: true,
      date: today,
      overdue: overdue.length,
      due: due.length,
      pendingOpen,
      quiet,
      notified: 0,
      queued: records.length,
      records
    };
  }

  // 通知（可选）：静默时段/非 macOS/超上限时只入队
  let notified = 0;
  if (notify && !quiet) {
    for (const rec of records) {
      if (day.notified + notified >= maxNotify) break;
      const title = rec.kind === 'digest' ? 'memoryd 今日摘要' : 'memoryd 提醒';
      const ok = notifyImpl(title, rec.text) !== false;
      if (ok) {
        rec.notified = true;
        rec.channel = 'osascript';
        notified++;
      } else {
        break;
      }
    }
  }

  for (const rec of records) appendLine(remindersFile(config, today), rec);

  st.reminders.lastRunAt = nowIso();
  st.reminders.daily[today] = { seen: [...seen], notified: day.notified + notified, digest: true };
  for (const d of Object.keys(st.reminders.daily)) {
    if (d < localDateOf(new Date(now.getTime() - PRUNE_DAYS * 86400e3))) delete st.reminders.daily[d];
  }
  writeJsonAtomic(paths.state, st);
  overlay.reload();

  return {
    dryRun: false,
    date: today,
    overdue: overdue.length,
    due: due.length,
    pendingOpen,
    quiet,
    notified,
    queued: records.length,
    records
  };
}

export function readReminders(config, date) {
  const file = remindersFile(config, date);
  return readJsonl(file);
}

export function listReminderDates(config) {
  try {
    return fs
      .readdirSync(remindersDir(config))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -6))
      .sort();
  } catch {
    return [];
  }
}
