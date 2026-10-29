#!/usr/bin/env node
// memoryd 入口：serve | mcp | context | doctor | version
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveConfig, PKG } from '../src/config.mjs';
import { Store, round2 } from '../src/store.mjs';
import { createApp, makeAppContext } from '../src/http.mjs';
import { runMcp } from '../src/mcp.mjs';
import { buildContext } from '../src/context.mjs';
import { Overlay } from '../src/overlay.mjs';
import { Inbox } from '../src/inbox.mjs';
import { runConsolidate } from '../src/consolidate.mjs';
import { applyFeedback } from '../src/feedback.mjs';
import { runRemind, readReminders } from '../src/remind.mjs';
import { exportMemory, importMemory } from '../src/transfer.mjs';
import { install as launchdInstall, uninstall as launchdUninstall, status as launchdStatus } from '../src/launchd.mjs';
import { localDate } from '../src/query.mjs';

const { _, flags } = parseArgs(process.argv.slice(2));
const cmd = _[0] || 'serve';
if (flags.help === true || flags.h === true) {
  usage();
  process.exit(0);
}
const config = resolveConfig(flags);

try {
  switch (cmd) {
    case 'serve':
      serve();
      break;
    case 'mcp':
      mcp();
      break;
    case 'context':
      context();
      break;
    case 'doctor':
      doctor();
      break;
    case 'consolidate':
      consolidate();
      break;
    case 'inbox':
      inbox();
      break;
    case 'feedback':
      feedback();
      break;
    case 'remind':
      remind();
      break;
    case 'export':
      exportCmd();
      break;
    case 'import':
      importCmd();
      break;
    case 'install':
      installCmd();
      break;
    case 'uninstall':
      uninstallCmd();
      break;
    case 'status':
      statusCmd();
      break;
    case 'version':
      console.log(`${PKG.name} ${PKG.version}`);
      break;
    case 'help':
      usage();
      process.exit(0);
    default:
      usage();
      process.exit(2);
  }
} catch (err) {
  console.error(`[memoryd] ${err.message}`);
  process.exit(1);
}

function usage() {
  console.error(
    [
      '用法：memoryd <serve|mcp|context|doctor|consolidate|inbox|feedback|remind|export|import|install|uninstall|status|version> [选项]',
      '',
      '  serve        启动 HTTP 服务（默认 127.0.0.1:7788，含 W2 写接口与后台 consolidator）',
      '  mcp          以 MCP stdio 方式运行（给 DSH / Claude Code 用）',
      '  context      输出注入上下文（--q 关键词，--budget 2000，--json 输出结构化）',
      '  consolidate  立即跑一次 inbox 整理（--once 语义，调试/验收用）',
      '  inbox        命令行写一条 note（--kind --text --agent）',
      '  feedback     命令行做反馈（--action done|forget|undo|pin --target c_/ac_/n_）',
      '  remind       跑一次提醒扫描（--notify 弹系统通知，--now ISO 注入时间，--dry-run 只打印）',
      '  export       导出 JSONL（--out 路径，--no-base 只导 overlay）',
      '  import       导入 JSONL（默认 dry-run，--yes 才写入；只增不改、只写 overlay）',
      '  install      生成/安装 launchd 常驻（默认 dry-run，--yes 才写 ~/Library/LaunchAgents）',
      '  uninstall    卸载 launchd 常驻（需 --yes）',
      '  status       launchd 与 /health 状态',
      '  doctor       自检：数据文件、权限、计数、预算、overlay 状态',
      '',
      '选项：--port --host --root --budget --k --q --json --kind --text --agent --action --target',
      '      --out --no-base --yes --now --notify --dry-run --remind-ms --quiet-start --quiet-end --max-notify'
    ].join('\n')
  );
}

function serve() {
  const store = new Store(config);
  try {
    store.load();
  } catch (err) {
    console.error(`[memoryd] 数据不可用，服务将以 degraded 启动：${err.message}`);
  }
  const ctx = makeAppContext(store, config);
  const app = createApp(ctx, config);
  app.on('error', (err) => {
    console.error(`[memoryd] 监听失败：${err.message}`);
    process.exit(1);
  });
  app.listen(config.port, config.host, () => {
    const s = store.available ? store.get() : null;
    const stat = s ? `${s.cards.length} 卡 / ${s.days.withCards} 天` : '无数据';
    console.error(`[memoryd] listening http://${config.host}:${config.port}/  (${stat})`);
    console.error(`[memoryd] UI http://${config.host}:${config.port}/  |  数据 ${path.relative(config.root, store.paths.cards)}`);
  });

  // W2：启动补跑 + 定时整理（单实例锁在 runConsolidate 内）
  const run = (trigger) => {
    try {
      const r = runConsolidate({ store, overlay: ctx.overlay, config, trigger });
      if (!r.locked) {
        console.error(
          `[memoryd] consolidate(${trigger}) processed=${r.processed} cards=${r.cards} reviews=${r.reviews} noop=${r.noop} ${r.durationMs}ms`
        );
      }
    } catch (err) {
      console.error(`[memoryd] consolidate 失败：${err.message}`);
    }
  };
  const boot = setTimeout(() => run('startup'), 1500);
  boot.unref();
  const timer = setInterval(() => run('timer'), config.consolidateMs);
  timer.unref();

  // W3a：提醒扫描（默认只入队；--notify / MEMORYD_NOTIFY=1 才弹系统通知）
  const runR = (trigger) => {
    try {
      const r = runRemind(ctx, {});
      if (r.queued || r.notified) {
        console.error(
          `[memoryd] remind(${trigger}) queued=${r.queued} notified=${r.notified} overdue=${r.overdue} due=${r.due} quiet=${r.quiet}`
        );
      }
    } catch (err) {
      console.error(`[memoryd] remind 失败：${err.message}`);
    }
  };
  const remindBoot = setTimeout(() => runR('startup'), 2500);
  remindBoot.unref();
  const remindTimer = setInterval(() => runR('timer'), config.remindMs);
  remindTimer.unref();

  const stop = () => {
    console.error('[memoryd] shutdown');
    clearInterval(timer);
    clearTimeout(boot);
    clearInterval(remindTimer);
    clearTimeout(remindBoot);
    app.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function mcp() {
  const store = new Store(config);
  runMcp(makeAppContext(store, config), config);
}

function context() {
  const store = new Store(config);
  const state = store.load();
  const built = buildContext(state, {
    q: typeof flags.q === 'string' ? flags.q : '',
    budget: config.budget,
    date: typeof flags.date === 'string' ? flags.date : undefined
  });
  if (flags.json) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }
  console.log(built.text);
  console.error(
    `[memoryd] chars=${built.chars} estTokens=${built.estTokens} budget=${built.budget} hits=${built.hits}`
  );
}

function consolidate() {
  const store = new Store(config);
  store.load();
  const overlay = new Overlay(config);
  const result = runConsolidate({ store, overlay, config, trigger: 'cli' });
  console.log(JSON.stringify(result, null, 2));
}

function inbox() {
  const store = new Store(config);
  store.load();
  const overlay = new Overlay(config);
  const result = new Inbox(config, overlay).accept({
    kind: flags.kind,
    text: flags.text,
    source: { agent: typeof flags.agent === 'string' ? flags.agent : 'cli' },
    idempotency_key: flags['idempotency-key']
  });
  console.log(JSON.stringify(result, null, 2));
}

function feedback() {
  const store = new Store(config);
  store.load();
  const overlay = new Overlay(config);
  const record = applyFeedback({
    store,
    overlay,
    config,
    action: flags.action,
    target: flags.target,
    agent: typeof flags.agent === 'string' ? flags.agent : 'cli'
  });
  console.log(JSON.stringify(record, null, 2));
}

function remind() {
  const store = new Store(config);
  store.load();
  const ctx = makeAppContext(store, config);
  const result = runRemind(ctx, {
    now: typeof flags.now === 'string' ? new Date(flags.now) : undefined,
    dryRun: flags['dry-run'] === true,
    notify: flags.notify === true ? true : undefined
  });
  console.log(JSON.stringify(result, null, 2));
}

function exportCmd() {
  const store = new Store(config);
  store.load();
  const ctx = makeAppContext(store, config);
  const result = exportMemory(ctx, {
    out: typeof flags.out === 'string' ? flags.out : undefined,
    includeBase: flags['no-base'] !== true
  });
  console.log(JSON.stringify(result, null, 2));
}

function importCmd() {
  const store = new Store(config);
  store.load();
  const ctx = makeAppContext(store, config);
  const file = _[1] || (typeof flags.file === 'string' ? flags.file : '');
  if (!file) {
    console.error('用法：memoryd import <file.jsonl> [--dry-run|--yes]');
    process.exit(2);
  }
  const result = importMemory(ctx, { file, dryRun: flags.yes !== true });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.error('[memoryd] dry-run：未写入。确认后加 --yes');
}

function installCmd() {
  const result = launchdInstall(config, { yes: flags.yes === true });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.error('[memoryd] dry-run：未写 ~/Library/LaunchAgents。确认后加 --yes');
  else console.error(`[memoryd] 已安装 ${result.label}，日志 ${path.join(config.outDir, 'memoryd.{out,err}.log')}`);
}

function uninstallCmd() {
  const result = launchdUninstall(config, { yes: flags.yes === true });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.error('[memoryd] dry-run：未删除。确认后加 --yes');
}

function statusCmd() {
  const result = launchdStatus(config, {});
  console.log(JSON.stringify(result, null, 2));
}

function doctor() {
  const store = new Store(config);
  const lines = [`memoryd ${PKG.version} doctor`, `root: ${config.root}`];
  let ok = true;
  for (const [name, file] of [
    ['cards', store.paths.cards],
    ['bundle', store.paths.bundle]
  ]) {
    try {
      const st = fs.statSync(file);
      const mode = (st.mode & 0o777).toString(8);
      lines.push(`${name}: ${path.relative(config.root, file)}  ${st.size}B  mode=${mode}  ${new Date(st.mtimeMs).toISOString()}`);
    } catch {
      lines.push(`${name}: 缺失 ${file}`);
      ok = false;
    }
  }
  const uiIndex = path.join(config.uiDir, 'index.html');
  lines.push(`ui: ${fs.existsSync(uiIndex) ? 'ok' : '缺失'} ${path.relative(config.root, uiIndex)}`);

  try {
    const s = store.load();
    const built = buildContext(s, { q: '偏好', budget: 2000 });
    lines.push(
      `data: cards=${s.cards.length} days=${s.days.withCards}(${s.days.from}~${s.days.to}) ` +
        `commitments=${s.commitments.total}(pending ${s.commitments.pending}, done ${s.commitments.done}) ` +
        `topics=${s.topics.length} entities=${s.entities.length}`
    );
    lines.push(
      `index: ${s.indexMs}ms  context: chars=${built.chars} estTokens=${built.estTokens} budget=${built.budget}`
    );
    const fresh = round2((Date.now() - s.cardsMtimeMs) / 1000);
    lines.push(`freshness: 数据 ${fresh}s 前更新${fresh > 26 * 3600 ? '（⚠ 超过 26h，检查每日增量）' : ''}`);
  } catch (err) {
    lines.push(`data: 不可用（${err.message}）`);
    ok = false;
  }
  try {
    const overlay = new Overlay(config);
    overlay.load();
    const meta = overlay.meta();
    lines.push(
      `overlay: notes=${meta.notes} cards=${meta.agentCards} reviewPending=${meta.reviewPending} ` +
        `lastConsolidate=${meta.lastConsolidateAt || '未跑过'}${meta.lastError ? ' ⚠ ' + meta.lastError : ''}`
    );
    lines.push(`overlayDir: ${path.relative(config.root, config.outDir)}（gitignore，700）`);
  } catch (err) {
    lines.push(`overlay: 读取失败（${err.message}）`);
  }
  try {
    const today = localDate();
    const reminders = readReminders(config, today);
    lines.push(`reminders: 今天 ${reminders.length} 条（--notify ${config.remindNotify ? '开' : '关'}，静默 ${config.remindQuietStart}–${config.remindQuietEnd}，上限 ${config.remindDailyNotifyMax}/天）`);
  } catch {
    lines.push('reminders: 读取失败');
  }
  lines.push(`port: ${config.port}（serve 时使用）`);
  console.log(lines.join('\n'));
  if (!ok) process.exit(1);
}
