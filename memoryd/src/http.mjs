// HTTP 入口：默认只读 GET；W2 增加 3 个 POST 写接口（/inbox /consolidate /feedback /review/:id/*）。
// 绑定 127.0.0.1、Host 白名单、无 CORS；写接口不引入鉴权（本机信任模型）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { recall } from './recall.mjs';
import { buildToday } from './today.mjs';
import { buildContext } from './context.mjs';
import { dataAgeSec, isStale, round2 } from './store.mjs';
import { PKG } from './config.mjs';
import { isValidDate, localDate } from './query.mjs';
import { AppError, parseJsonBody, readBody } from './util.mjs';
import { Overlay, recentNotes, recentWrites } from './overlay.mjs';
import { ViewManager } from './view.mjs';
import { Inbox } from './inbox.mjs';
import { runConsolidate } from './consolidate.mjs';
import { applyFeedback } from './feedback.mjs';
import { listReviews, decideReview } from './review.mjs';
import { buildMergedBundle, bundleEtag } from './graph.mjs';
import { readReminders } from './remind.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

const GET_ROUTES = new Set([
  '/health',
  '/today',
  '/profile',
  '/recall',
  '/context',
  '/graph',
  '/inbox/recent',
  '/review',
  '/writes/recent',
  '/reminders'
]);

/** 兼容两种调用：createApp(ctx, config)（serve 用）或 createApp(store, config)（W1 测试用）。 */
export function createApp(ctxOrStore, config) {
  const ctx = ctxOrStore && ctxOrStore.store ? { ...ctxOrStore } : makeAppContext(ctxOrStore, config);
  ctx.config = config;
  ctx.startedAt = Date.now();
  const server = http.createServer((req, res) => handle(req, res, ctx));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

export function makeAppContext(store, config) {
  const overlay = new Overlay(config);
  const view = new ViewManager(store, overlay);
  const inbox = new Inbox(config, overlay);
  return { store, config, overlay, view, inbox };
}

async function handle(req, res, ctx) {
  const t0 = process.hrtime.bigint();
  let logPath = '?';
  try {
    ctx.store.maybeReload();
    if (!hostAllowed(req.headers.host)) {
      throw new AppError(403, 'FORBIDDEN', 'Host 不在白名单（只接受 127.0.0.1 / localhost）');
    }
    const url = new URL(req.url, 'http://localhost');
    logPath = url.pathname;
    const method = req.method || 'GET';

    if (method === 'POST') {
      return await handlePost(req, res, ctx, url);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      if (GET_ROUTES.has(url.pathname)) {
        throw new AppError(405, 'METHOD_NOT_ALLOWED', '该接口只支持 GET/HEAD');
      }
      throw new AppError(405, 'METHOD_NOT_ALLOWED', '只支持 GET/HEAD/POST');
    }

    switch (url.pathname) {
      case '/health': {
        const body = healthBody(ctx);
        return sendJson(res, body.ok ? 200 : 503, body, method === 'HEAD');
      }
      case '/today':
        return sendJson(res, 200, todayBody(ctx, url), method === 'HEAD');
      case '/profile':
        return sendJson(res, 200, profileBody(ctx), method === 'HEAD');
      case '/recall':
        return sendJson(res, 200, recallBody(ctx, url), method === 'HEAD');
      case '/context':
        return sendJson(res, 200, contextBody(ctx, url), method === 'HEAD');
      case '/graph':
        return sendGraph(ctx, req, res, url);
      case '/data.js':
        return sendDataJs(ctx, req, res, url);
      case '/inbox/recent':
        return sendJson(res, 200, inboxRecentBody(ctx, url), method === 'HEAD');
      case '/review':
        return sendJson(res, 200, reviewBody(ctx, url), method === 'HEAD');
      case '/writes/recent':
        return sendJson(res, 200, writesRecentBody(ctx, url), method === 'HEAD');
      case '/reminders':
        return sendJson(res, 200, remindersBody(ctx, url), method === 'HEAD');
      default:
        break;
    }
    return serveStatic(ctx, req, res, url);
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || 'INTERNAL';
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, status, { ok: false, error: { code, message: safeMessage(err, status) } }, req.method === 'HEAD');
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stderr.write(`[memoryd] ${req.method} ${logPath} ${res.statusCode} ${round2(ms)}ms\n`);
  }
}

async function handlePost(req, res, ctx, url) {
  const isInbox = url.pathname === '/inbox';
  const isConsolidate = url.pathname === '/consolidate';
  const isFeedback = url.pathname === '/feedback';
  const reviewMatch = url.pathname.match(/^\/review\/([A-Za-z0-9_-]{1,64})\/(approve|reject)$/);
  if (!isInbox && !isConsolidate && !isFeedback && !reviewMatch) {
    if (GET_ROUTES.has(url.pathname)) {
      res.setHeader('Allow', 'GET, HEAD');
      throw new AppError(405, 'METHOD_NOT_ALLOWED', '该接口只支持 GET/HEAD');
    }
    throw new AppError(404, 'NOT_FOUND', '接口不存在');
  }
  const body = parseJsonBody(await readBody(req));

  if (isInbox) {
    const result = ctx.inbox.accept(body);
    return sendJson(res, 202, { ok: true, data: result });
  }
  if (isConsolidate) {
    const result = runConsolidate({
      store: ctx.store,
      overlay: ctx.overlay,
      config: ctx.config,
      trigger: 'http'
    });
    return sendJson(res, 200, { ok: true, data: result });
  }
  if (isFeedback) {
    const record = applyFeedback({
      store: ctx.store,
      overlay: ctx.overlay,
      config: ctx.config,
      action: body.action,
      target: body.target,
      agent: body.agent,
      reason: body.reason
    });
    return sendJson(res, 200, { ok: true, data: record });
  }
  if (reviewMatch) {
    const result = decideReview({
      overlay: ctx.overlay,
      config: ctx.config,
      reviewId: reviewMatch[1],
      decision: reviewMatch[2],
      actor: body.actor
    });
    return sendJson(res, 200, { ok: true, data: result });
  }
}

function safeMessage(err, status) {
  if (status >= 500) return err.expose ? err.message : '服务内部错误';
  return err.message;
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return true; // 本机脚本/HTTP1.0 允许无 Host；DNS rebinding 必带 Host
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

function sendJson(res, status, body, headOnly) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(headOnly ? undefined : text);
}

function healthBody({ store, config, startedAt, overlay, view }) {
  if (!store.available) {
    return {
      ok: false,
      error: { code: 'DATA_UNAVAILABLE', message: store.state?.lastError || '数据不可用' }
    };
  }
  const s = store.get();
  const merged = view.get();
  return {
    ok: true,
    data: {
      status: s.lastError || merged.overlayMeta?.lastError ? 'degraded' : 'ok',
      version: PKG.version,
      cards: s.cards.length,
      commitments: s.commitments,
      days: { from: s.days.from, to: s.days.to, withCards: s.days.withCards },
      loadedAt: s.loadedAt,
      data: {
        cardsMtime: s.cardsMtime,
        bundleMtime: s.bundleMtime,
        ageSec: dataAgeSec(s),
        stale: isStale(s)
      },
      overlay: {
        ...merged.overlayMeta,
        visibleAgentCards: merged.viewMeta?.agentVisible ?? null,
        stateGlobalToday: null
      },
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      indexMs: s.indexMs,
      lastError: s.lastError || merged.overlayMeta?.lastError || null,
      paths: {
        cards: path.relative(config.root, store.paths.cards),
        bundle: path.relative(config.root, store.paths.bundle),
        overlay: path.relative(config.root, config.outDir)
      }
    }
  };
}

function todayBody({ view }, url) {
  const date = url.searchParams.get('date') || undefined;
  if (date && !isValidDate(date)) throw new AppError(400, 'BAD_REQUEST', 'date 必须是合法的 YYYY-MM-DD 日期');
  const limit = clampInt(url.searchParams.get('limit'), 5, 1, 20);
  return { ok: true, data: buildToday(view.get(), { date, limit }) };
}

function profileBody({ store }) {
  const s = store.get();
  const types = {};
  for (const doc of s.docs) types[doc.card.type] = (types[doc.card.type] || 0) + 1;
  return {
    ok: true,
    data: {
      persona: {
        label: s.bundle.persona?.label || '',
        content: s.bundle.persona?.content || ''
      },
      profiles: (s.bundle.profiles || []).map((p) => ({ k: p.k, v: p.v })),
      topics: s.topics,
      entities: s.entities,
      stats: {
        cards: s.cards.length,
        days: { from: s.days.from, to: s.days.to, withCards: s.days.withCards },
        commitments: s.commitments,
        types
      }
    }
  };
}

function recallBody({ view }, url) {
  const t0 = process.hrtime.bigint();
  const includeAgent = url.searchParams.get('include_agent') !== '0';
  const s = includeAgent ? view.get() : view.getBaseOnly();
  const params = {
    q: url.searchParams.get('q') || '',
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    topic: url.searchParams.get('topic') || undefined,
    entity: url.searchParams.get('entity') || undefined,
    type: url.searchParams.get('type') || undefined,
    cat: url.searchParams.get('cat') || undefined,
    k: url.searchParams.get('k') || undefined,
    includeSource: url.searchParams.get('include_source') === '1'
  };
  const result = recall(s, params);
  const tookMs = round2(Number(process.hrtime.bigint() - t0) / 1e6);
  return {
    ok: true,
    data: {
      query: {
        q: params.q,
        from: params.from || null,
        to: params.to || null,
        topic: params.topic || null,
        entity: params.entity || null,
        type: params.type || null,
        cat: params.cat || null,
        k: Math.min(50, Math.max(1, Number(params.k) || 8)),
        include_agent: includeAgent
      },
      understood: result.understood,
      total: result.total,
      items: result.items,
      tookMs
    }
  };
}

function contextBody({ view, config }, url) {
  const q = url.searchParams.get('q') || '';
  const budget = clampInt(url.searchParams.get('budget'), config.budget, 200, 8000);
  const date = url.searchParams.get('date') || undefined;
  if (date && !isValidDate(date)) throw new AppError(400, 'BAD_REQUEST', 'date 必须是合法的 YYYY-MM-DD 日期');
  return { ok: true, data: { q, ...buildContext(view.get(), { q, budget, date }) } };
}

function inboxRecentBody({ overlay }, url) {
  overlay.maybeReload();
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
  return { ok: true, data: { items: recentNotes(overlay.get(), limit) } };
}

function reviewBody({ overlay }, url) {
  const status = url.searchParams.get('status') || 'pending';
  return { ok: true, data: { status, items: listReviews(overlay, status) } };
}

function remindersBody({ config }, url) {
  const date = url.searchParams.get('date') || localDate();
  if (!isValidDate(date)) throw new AppError(400, 'BAD_REQUEST', 'date 必须是合法的 YYYY-MM-DD 日期');
  const items = readReminders(config, date);
  const counts = { total: items.length, digest: 0, overdue: 0, due_today: 0, notified: 0 };
  for (const it of items) {
    if (it.kind === 'digest') counts.digest++;
    else if (it.kind === 'overdue') counts.overdue++;
    else if (it.kind === 'due_today') counts.due_today++;
    if (it.notified) counts.notified++;
  }
  return { ok: true, data: { date, counts, items } };
}

function writesRecentBody({ overlay }, url) {
  overlay.maybeReload();
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
  return { ok: true, data: { items: recentWrites(overlay.get(), limit) } };
}

// 页面/接口共用的 bundle 选择：有 agent 卡或卡片级写回（done/pin/forget）且未要求排除时用合并 bundle，否则原样回基座
function pageBundle(ctx, includeAgent) {
  const view = ctx.view.get();
  const hasAgent = (view.viewMeta?.agentVisible || 0) > 0;
  const hasCardFeedback = (view.viewMeta?.cardFeedback || 0) > 0;
  if (!includeAgent || (!hasAgent && !hasCardFeedback)) {
    return { bundle: ctx.store.get().bundle, merged: false };
  }
  return { bundle: buildMergedBundle(view), merged: true };
}

function sendGraph(ctx, req, res, url) {
  const includeAgent = url.searchParams.get('include_agent') !== '0';
  const { bundle, merged } = pageBundle(ctx, includeAgent);
  const text = JSON.stringify(bundle);
  const base = ctx.store.get();
  const etag = merged
    ? bundleEtag(bundle)
    : `W/"${Math.round(base.cardsMtimeMs)}-${Buffer.byteLength(JSON.stringify(base.bundle))}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag
  });
  res.end(req.method === 'HEAD' ? undefined : text);
}

// 由 memoryd 托管页面时，/data.js 返回合并 bundle（前端仍按原样加载 data.js）
function sendDataJs(ctx, req, res, url) {
  const includeAgent = url.searchParams.get('include_agent') !== '0';
  const { bundle, merged } = pageBundle(ctx, includeAgent);
  const text = 'window.__MEMORY__ = ' + JSON.stringify(bundle) + ';\n';
  const base = ctx.store.get();
  const etag = merged
    ? bundleEtag(bundle)
    : `W/"data-${Math.round(base.cardsMtimeMs)}-${Buffer.byteLength(text)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag
  });
  res.end(req.method === 'HEAD' ? undefined : text);
}

function serveStatic({ config }, req, res, url) {
  const uiDir = path.resolve(config.uiDir);
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new AppError(400, 'BAD_REQUEST', '非法 URL 编码');
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) {
    throw new AppError(404, 'NOT_FOUND', '文件不存在');
  }
  const file = path.resolve(uiDir, rel);
  if (file !== uiDir && !file.startsWith(uiDir + path.sep)) {
    throw new AppError(403, 'FORBIDDEN', '路径越界');
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new AppError(404, 'NOT_FOUND', '文件不存在');
  }
  if (!stat.isFile()) throw new AppError(404, 'NOT_FOUND', '文件不存在');

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function clampInt(v, fallback, min, max) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
