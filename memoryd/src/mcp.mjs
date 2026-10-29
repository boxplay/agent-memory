// MCP stdio：逐行 JSON-RPC 2.0，旧版（2025-era）语义。
// 固定回 protocolVersion=2025-06-18（DSH 内置 SDK 与 Claude Code 都支持），只暴露只读 tools。
// 约束：stdout 只输出协议消息，日志一律 stderr。
import { PKG } from './config.mjs';
import { recall, renderRecall } from './recall.mjs';
import { buildToday, renderToday } from './today.mjs';
import { buildContext } from './context.mjs';
import { round2 } from './store.mjs';
import { Overlay } from './overlay.mjs';
import { ViewManager } from './view.mjs';
import { Inbox } from './inbox.mjs';
import { applyFeedback } from './feedback.mjs';
import { readReminders } from './remind.mjs';
import { localDate } from './query.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'memoryd';

const INSTRUCTIONS =
  '本地记忆（memoryd）：涉及用户过往的偏好、决定、承诺/待办、某天做过什么，或需要回顾历史时，' +
  '先调用 memory_recall / memory_today / memory_profile 查询；查不到就说没有，不要编造。' +
  '当用户明确要求"记住/记一下/别忘"时，调用 memory_note 写入（只记这一件事，不要自动把整段对话写进来）；' +
  '用户说做完了/忘掉/撤销时调用 memory_feedback。';

const TOOLS = [
  {
    name: 'memory_recall',
    description:
      '检索本地长期记忆（只读）。用于回答「某天做了什么」「我的偏好/决定/待办」「关于某主题/实体有什么记录」。' +
      '支持自然语言问题（内置日期与意图识别），也支持显式过滤。返回卡片文本、日期、类型与 id。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '自然语言问题或关键词，如「我在可视化上有什么偏好？」' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
        topic: { type: 'string', description: '主题过滤（如 工程/可视化/费用/评测/协作/语音模型/记忆管理/硬件）' },
        entity: { type: 'string', description: '实体过滤（如 DSH/Claude Code/GitHub/Cumora/小米 LX06/Codex/Ollama）' },
        type: {
          type: 'string',
          enum: ['fact', 'decision', 'event', 'commitment', 'preference', 'correction'],
          description: '卡片类型过滤'
        },
        cat: { type: 'string', enum: ['work', 'daily'], description: '分类过滤' },
        include_agent: { type: 'boolean', description: '是否包含 agent 写入的记忆，默认 true；false 只看本地会话抽取的基座卡' },
        k: { type: 'integer', description: '返回条数，默认 8，最大 50' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_today',
    description:
      '今天（或指定日期）的记忆摘要：到期/逾期的承诺、未完成待办、今日要点。用户问「今天要做什么/有什么到期」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
        limit: { type: 'integer', description: '每类最多条数，默认 5' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_profile',
    description: '用户画像：人设、身份、偏好、常用主题与实体、记忆规模统计。回答涉及「我是谁/我的偏好」时先查它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'memory_context',
    description:
      '生成可直接放进上下文的记忆摘要（persona + 画像 + 今天 + 相关记忆），受 token/字符预算约束（默认 2000）。' +
      '需要一次性把记忆注入给模型时使用，比逐条 recall 更省调用。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '当前问题或关键词，用于选相关记忆' },
        budget: { type: 'integer', description: '预算（字符/token 上限），默认 2000，范围 200–8000' },
        date: { type: 'string', description: '「今天」的日期 YYYY-MM-DD，默认今天' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_note',
    description:
      '把用户明确要求长期记住的一件事写入本地记忆（异步整理，约 2 分钟内可检索）。' +
      '只记用户明确要求记住的内容，不要自动把整段对话写进来；text 3–500 字。重复提交按幂等去重。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['commitment', 'preference', 'fact', 'event', 'decision', 'correction'],
          description: '记忆类型：承诺/偏好/事实/事件/决定/更正'
        },
        text: { type: 'string', description: '要记住的内容（3–500 字）' },
        session: { type: 'string', description: '可选：会话标识，便于追溯' },
        idempotency_key: { type: 'string', description: '可选：幂等键，同一个 key 只写一次' }
      },
      required: ['kind', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_reminders',
    description:
      '读取本地提醒队列（今天或指定日期的到期/逾期承诺与当日摘要）。用户问「今天有什么到期/提醒」时使用；' +
      '提醒由 memoryd 后台扫描生成，默认只入队、不主动弹系统通知。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_feedback',
    description:
      '对已有记忆做反馈：done（完成承诺）、forget（遗忘一张卡）、undo（撤销一条笔记）、pin（置顶）。' +
      'target 传 card_id（c_/ac_）或 note_id（n_）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['done', 'forget', 'undo', 'pin'] },
        target: { type: 'string', description: 'card_id（c_/ac_）或 note_id（n_）' }
      },
      required: ['action', 'target'],
      additionalProperties: false
    }
  }
];

function profileText(state) {
  const lines = [`## 人设\n${state.bundle.persona?.label || ''}：${state.bundle.persona?.content || ''}`, '## 画像'];
  for (const p of state.bundle.profiles || []) lines.push(`- ${p.k}：${p.v}`);
  lines.push('## 主题');
  lines.push(state.topics.slice(0, 12).map((t) => `${t.name}(${t.count})`).join('、'));
  lines.push('## 实体');
  lines.push(state.entities.slice(0, 10).map((e) => `${e.name}(${e.count})`).join('、'));
  lines.push('## 统计');
  lines.push(
    `卡片 ${state.cards.length}｜天 ${state.days.withCards}（${state.days.from}~${state.days.to}）｜` +
      `承诺 ${state.commitments.total}（pending ${state.commitments.pending}，done ${state.commitments.done}）`
  );
  return lines.join('\n');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
}

function handleTool(ctx, name, args = {}, clientAgent = 'mcp') {
  const view = ctx.view.get();
  switch (name) {
    case 'memory_recall': {
      const state = args.include_agent === false ? ctx.view.getBaseOnly() : view;
      const result = recall(state, {
        q: typeof args.q === 'string' ? args.q : '',
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
        topic: typeof args.topic === 'string' ? args.topic : undefined,
        entity: typeof args.entity === 'string' ? args.entity : undefined,
        type: typeof args.type === 'string' ? args.type : undefined,
        cat: typeof args.cat === 'string' ? args.cat : undefined,
        k: args.k
      });
      const rendered = renderRecall(result, {
        q: args.q,
        from: args.from,
        to: args.to,
        topic: args.topic,
        entity: args.entity,
        type: args.type
      });
      return textResult(rendered);
    }
    case 'memory_today': {
      const date = typeof args.date === 'string' ? args.date : undefined;
      return textResult(renderToday(buildToday(view, { date, limit: args.limit })));
    }
    case 'memory_profile':
      return textResult(profileText(ctx.store.get()));
    case 'memory_context': {
      const budget = Number(args.budget) || ctx.config.budget;
      const built = buildContext(view, {
        q: typeof args.q === 'string' ? args.q : '',
        budget,
        date: typeof args.date === 'string' ? args.date : undefined
      });
      return textResult(built.text);
    }
    case 'memory_note': {
      const result = ctx.inbox.accept({
        kind: args.kind,
        text: args.text,
        source: { agent: clientAgent, session: args.session },
        idempotency_key: args.idempotency_key
      });
      return textResult(
        result.deduped
          ? `已存在相同记忆（note_id ${result.note_id}），未重复写入。`
          : `已记下（note_id ${result.note_id}），约 2 分钟内可在记忆里检索到。`
      );
    }
    case 'memory_reminders': {
      const date = typeof args.date === 'string' && args.date ? args.date : localDate();
      const items = readReminders(ctx.config, date);
      if (items.length === 0) return textResult(`${date} 没有到期/逾期提醒。`);
      const lines = [`## 提醒（${date}）`];
      for (const it of items) {
        if (it.kind === 'digest') lines.push(`- 摘要：${it.text}`);
        else lines.push(`- ${it.kind === 'overdue' ? '逾期' : '到期'} ${it.due_at}：${it.text}${it.notified ? '（已通知）' : ''}`);
      }
      return textResult(lines.join('\n'));
    }
    case 'memory_feedback': {
      const record = applyFeedback({
        store: ctx.store,
        overlay: ctx.overlay,
        config: ctx.config,
        action: args.action,
        target: args.target,
        agent: clientAgent
      });
      return textResult(`已执行 ${record.action}：${record.target}`);
    }
    default:
      throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
  }
}

function makeCtx(store, config) {
  const overlay = new Overlay(config);
  const view = new ViewManager(store, overlay);
  const inbox = new Inbox(config, overlay);
  return { store, config, overlay, view, inbox };
}

export function runMcp(storeOrCtx, config) {
  const ctx = storeOrCtx && storeOrCtx.store ? storeOrCtx : makeCtx(storeOrCtx, config);
  const store = ctx.store;
  store.load();
  process.stderr.write(`[memoryd] mcp ready（${PROTOCOL_VERSION}，${store.state.cards.length} 卡）\n`);

  // 客户端可能先断开（例如 head/管道关闭），不要因此崩溃
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  let clientAgent = 'mcp';
  const write = (msg) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const dispatch = (msg) => {
    const { id, method, params } = msg;
    if (typeof method !== 'string') {
      if (id !== undefined) fail(id, -32600, 'Invalid Request');
      return;
    }
    // 通知：不回包
    if (method.startsWith('notifications/')) return;

    switch (method) {
      case 'initialize': {
        const rawName = String(params?.clientInfo?.name || 'mcp');
        clientAgent = /^[A-Za-z0-9_-]{1,32}$/.test(rawName) ? rawName : 'mcp';
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: PKG.version },
          instructions: INSTRUCTIONS
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return;
      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string') {
          fail(id, -32602, 'tools/call 需要 name');
          return;
        }
        const t0 = process.hrtime.bigint();
        try {
          store.maybeReload();
          const result = handleTool(ctx, name, params?.arguments || {}, clientAgent);
          process.stderr.write(
            `[memoryd] mcp ${name} ok ${round2(Number(process.hrtime.bigint() - t0) / 1e6)}ms\n`
          );
          reply(id, result);
        } catch (err) {
          process.stderr.write(`[memoryd] mcp ${name} error: ${err.message}\n`);
          reply(id, errorResult(err.message));
        }
        return;
      }
      default:
        if (id !== undefined) fail(id, -32601, `未知方法：${method}`);
    }
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error');
        continue;
      }
      try {
        dispatch(msg);
      } catch (err) {
        if (msg && msg.id !== undefined) fail(msg.id, -32603, err.message);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
