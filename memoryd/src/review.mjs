// review 队列：低置信 / correction / 疑似重复 → 人工确认后生效或拒绝。
import { overlayPaths, findNote } from './overlay.mjs';
import { AppError, appendLine, nowIso, sha1 } from './util.mjs';
import { buildAgentCard } from './consolidate.mjs';

export function listReviews(overlay, status = 'pending') {
  overlay.reload();
  const snap = overlay.get();
  const list = status === 'all' ? [...snap.reviewLatest.values()] : snap.reviewPending;
  return list.map((r) => ({
    review_id: r.review_id,
    note_id: r.note_id,
    reason: r.reason,
    status: r.status,
    created_at: r.created_at,
    candidate: r.candidate
      ? {
          type: r.candidate.type,
          cat: r.candidate.cat,
          text: r.candidate.text,
          due_at: r.candidate.due_at || null,
          confidence: r.candidate.confidence
        }
      : null
  }));
}

export function decideReview({ overlay, config, reviewId, decision, actor = 'manual' }) {
  overlay.reload();
  const snap = overlay.get();
  const rv = snap.reviewLatest.get(reviewId);
  if (!rv) throw new AppError(404, 'NOT_FOUND', `review 不存在：${reviewId}`);
  if (rv.status !== 'pending') throw new AppError(409, 'ALREADY_HANDLED', `review 已是 ${rv.status} 状态`);

  const paths = overlayPaths(config);
  if (decision === 'approve') {
    const note = findNote(snap, rv.note_id);
    const card = rv.candidate || (note ? buildAgentCard(note) : null);
    if (!card) throw new AppError(404, 'NOT_FOUND', 'note 已不存在，无法批准');
    if (!snap.agentCards.some((c) => c.id === card.id)) appendLine(paths.agentCards, card);
    appendLine(paths.review, { ...rv, status: 'approved', actor, decided_at: nowIso() });
    overlay.reload();
    return { status: 'approved', card_id: card.id };
  }
  if (decision === 'reject') {
    appendLine(paths.review, { ...rv, status: 'rejected', actor, decided_at: nowIso() });
    // 拒绝 = 撤销该 note，防止以后重跑复活
    appendLine(paths.feedback, {
      feedback_id: `fb_${sha1(`undo|${rv.note_id}|${actor}|${nowIso()}`).slice(12)}`,
      action: 'undo',
      target: rv.note_id,
      target_type: 'note',
      agent: String(actor).slice(0, 32),
      at: nowIso(),
      reason: 'review_rejected'
    });
    overlay.reload();
    return { status: 'rejected' };
  }
  throw new AppError(400, 'BAD_REQUEST', 'decision 必须是 approve / reject');
}
