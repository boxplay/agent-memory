// 反馈：done（完成承诺）/ forget（遗忘卡）/ undo（撤销笔记）/ pin（置顶）。
// 全部写 append-only feedback.jsonl，读层根据派生集合生效。
import { overlayPaths } from './overlay.mjs';
import { AppError, appendLine, nowIso, sha1 } from './util.mjs';

const ACTIONS = new Set(['done', 'forget', 'undo', 'pin']);

export function applyFeedback({ store, overlay, config, action, target, agent = 'manual', reason }) {
  const act = String(action || '');
  if (!ACTIONS.has(act)) throw new AppError(400, 'BAD_REQUEST', `action 必须是 ${[...ACTIONS].join('/')}`);
  const t = String(target || '');
  if (!/^[a-z]{1,2}_[A-Za-z0-9]+$/.test(t)) {
    throw new AppError(400, 'BAD_REQUEST', 'target 必须是 card_id（c_/ac_）或 note_id（n_）');
  }
  store.maybeReload();
  overlay.reload();
  const snap = overlay.get();
  const baseIds = new Set(store.get().cards.map((c) => c.id));
  const agentIds = new Set(snap.agentCards.map((c) => c.id));
  const noteIds = new Set(snap.notes.map((n) => n.note_id));
  const isCard = t.startsWith('c_') || t.startsWith('ac_');
  const isNote = t.startsWith('n_');

  if (isCard && !(baseIds.has(t) || agentIds.has(t))) {
    throw new AppError(404, 'NOT_FOUND', `卡片不存在：${t}`);
  }
  if (isNote && !noteIds.has(t)) {
    throw new AppError(404, 'NOT_FOUND', `笔记不存在：${t}`);
  }
  if (!isCard && !isNote) throw new AppError(400, 'BAD_REQUEST', '无法识别的 target 类型');
  if ((act === 'done' || act === 'pin') && !isCard) {
    throw new AppError(400, 'BAD_REQUEST', `${act} 只能针对卡片（c_/ac_）`);
  }

  const record = {
    feedback_id: `fb_${sha1(`${act}|${t}|${agent}|${nowIso()}|${Math.random()}`).slice(12)}`,
    action: act,
    target: t,
    target_type: isCard ? 'card' : 'note',
    agent: String(agent).slice(0, 32),
    at: nowIso(),
    reason: reason ? String(reason).slice(0, 120) : null
  };
  appendLine(overlayPaths(config).feedback, record);
  overlay.reload();
  return record;
}
