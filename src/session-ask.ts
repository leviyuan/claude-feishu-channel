/**
 * AskUserQuestion flow split out of session.ts. Codex and Claude both
 * route AskUserQuestion through can_use_tool, so the "answered" state
 * lives across two SDK control messages — option clicks/custom text
 * land via Feishu callbacks first, then can_use_tool arrives and we
 * finalize with `updatedInput.answers`.
 */

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'

/** True iff there's at least one open AskUserQuestion awaiting an
 * answer in this session. `daemon.handleMessage` uses this to
 * decide whether an inbound chat message should be a custom answer
 * (routed to onAskMessageAnswer) instead of opening a new turn. */
export function hasPendingAsk(s: Session): boolean {
  return s.pendingAsks.size > 0
}

/** Funnel an arbitrary chat message into the *current* question
 * of the oldest pending ask as a `customText` answer. Multi-
 * question semantics: from the user's perspective, the chat
 * input always answers whatever question is on screen right now
 * (`pending.currentIdx`), and a new question slides in after. */
export async function onAskMessageAnswer(s: Session, text: string, user: string, msgId: string): Promise<void> {
  const firstEntry = s.pendingAsks.entries().next()
  if (firstEntry.done) {
    log(`session "${s.sessionName}": onAskMessageAnswer with no pending — falling back to onUserMessage`)
    await s.onUserMessage(text, [], user, msgId)
    return
  }
  const [toolUseId, pending] = firstEntry.value
  if (pending.currentIdx === undefined) {
    // currentIdx undefined = 所有问题已答完。正常路径下 can_use_tool 一到,
    // finalizeAsk 立刻把这条 ask 从 pendingAsks 删掉;还能在这里读到它只有
    // 两种可能:
    //   1. requestId 已 park,正等 finalize 落地(亚秒级窗口)—— 真·瞬态,
    //      照旧忽略,别和 fast-clicker race 抢答。
    //   2. requestId 始终没来 —— can_use_tool 永不会到(SDK 在 ask 握手中途
    //      静默挂死,turn 既无 result 也不 exit)。这条 ask 是僵尸,会把整个
    //      session 焊死:hasPendingAsk() 恒 true,后续每条消息都被吞,连
    //      onUserMessage 都到不了,子进程也没机会重启。识破即逃生 —— 丢弃
    //      僵尸,把这条消息当普通 user message 重新处理(interrupt + 开新
    //      turn / 重启子进程),用户随手发一条就能自愈,不必去 stop+重启 daemon。
    if (pending.requestId) {
      log(`session "${s.sessionName}": pending ask ${toolUseId} awaiting finalize — ignoring message`)
      return
    }
    log(`session "${s.sessionName}": pending ask ${toolUseId} orphaned (no can_use_tool) — dropping zombie, reprocessing as user message`)
    s.pendingAsks.delete(toolUseId)
    await s.onUserMessage(text, [], user, msgId)
    return
  }
  // 这条文本确实落在一个 live 问题上 —— 当 ask 答案消费。只有真记账成功
  // (非空、非 stale)才回 ✅;否则这条消息没被收下,不该留"答案已收到"
  // 标记。✅ 原先在 daemon 路由层 hasPendingAsk() 为真就无条件抢打,僵尸
  // 自愈 / 兜底分支会残留一个语义错误的 ✅(消息其实被当普通新轮处理)——
  // 下沉到这里按真实消费结果打。
  const consumed = await onAskCustomAnswer(s, toolUseId, pending.currentIdx, text, user)
  if (consumed && msgId) void feishu.addReaction(msgId, 'CheckMark')
}

/** Click handler for an option button. The click must target the
 * question currently on screen (`pending.currentIdx`); a stale
 * click (e.g. user clicked an older render before it swapped in
 * the next question) is logged and dropped — better than double-
 * answering. */
export async function onAskAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  optionIdx: number,
  user: string,
): Promise<boolean> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask answer for ${toolUseId}`); return false }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask click q=${questionIdx} current=${pending.currentIdx}`)
    return false
  }
  return advanceAsk(s, toolUseId, { optionIdx, user })
}

/** Custom-text branch. Same staleness rule as onAskAnswer; empty
 * input is silently ignored (panel stays pending). Returns true iff
 * the text was actually recorded as the answer to the current
 * question — onAskMessageAnswer uses this to decide whether to stamp
 * the ✅ "answer received" reaction on the chat message. Stray /
 * empty / stale inputs return false and earn no ✅. (Card-action
 * callers ignore the return — they have their own toast.) */
export async function onAskCustomAnswer(
  s: Session,
  toolUseId: string,
  questionIdx: number,
  customText: string,
  user: string,
): Promise<boolean> {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending) { log(`session "${s.sessionName}": stray ask custom for ${toolUseId}`); return false }
  const trimmed = (customText ?? '').trim()
  if (!trimmed) { log(`session "${s.sessionName}": empty custom answer, ignoring`); return false }
  if (questionIdx !== pending.currentIdx) {
    log(`session "${s.sessionName}": stale ask custom q=${questionIdx} current=${pending.currentIdx}`)
    return false
  }
  return advanceAsk(s, toolUseId, { customText: trimmed, user })
}

/** Record an answer for the current question, advance the state
 * machine, repaint. If every question is now answered, finalize
 * (or defer the finalize until can_use_tool lands — the race is
 * handled by renderPermission). */
export function advanceAsk(
  s: Session,
  toolUseId: string,
  answer: { optionIdx?: number; customText?: string; user: string },
): boolean {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || pending.currentIdx === undefined) return false
  const cur = pending.currentIdx
  const q = pending.questions[cur]
  if (!q) { log(`session "${s.sessionName}": advanceAsk currentIdx=${cur} out of range`); return false }
  // Resolve the literal answer value — custom text wins if both set.
  let value: string
  if (answer.customText !== undefined) {
    value = answer.customText
  } else if (answer.optionIdx !== undefined) {
    const opt = q.options?.[answer.optionIdx]
    if (!opt) { log(`session "${s.sessionName}": advanceAsk option ${answer.optionIdx} out of range`); return false }
    value = opt.label
  } else {
    log(`session "${s.sessionName}": advanceAsk with neither customText nor optionIdx`)
    return false
  }
  pending.answers[q.question] = value
  pending.answered.set(cur, {
    optionIdx: answer.optionIdx,
    customText: answer.customText,
    user: answer.user,
  })
  // Next unanswered idx — linear from cur+1. Implementation
  // always moves forward; we don't currently let users revisit a
  // previous question (would need richer UI affordance for that).
  const total = pending.questions.length
  let nextIdx: number | undefined = undefined
  for (let i = cur + 1; i < total; i++) {
    if (!pending.answered.has(i)) { nextIdx = i; break }
  }
  pending.currentIdx = nextIdx

  const turn = s.currentTurn
  const meta = turn?.toolByUseId.get(toolUseId)
  if (turn && meta) {
    const el = cards.askUserQuestionElement(
      meta.i, toolUseId, pending.questions,
      nextIdx === undefined ? '✅' : '🤔',
      { currentIdx: nextIdx, answered: pending.answered },
    )
    void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(meta.i), el)
  }

  if (nextIdx === undefined) {
    // All done. Finalize iff we have the permission request id;
    // otherwise renderPermission will pick it up when it arrives.
    if (pending.requestId) finalizeAsk(s, toolUseId)
    else log(`session "${s.sessionName}": ask ${toolUseId} all answered, waiting for can_use_tool`)
  }
  return true
}

/** Settle a fully-answered AskUserQuestion: emit the SDK allow
 * with the full `answers` record folded into `updatedInput`,
 * drop bookkeeping, restore status. The terminal panel paint was
 * already done by the final advanceAsk; this is just protocol. */
export function finalizeAsk(s: Session, toolUseId: string): void {
  const pending = s.pendingAsks.get(toolUseId)
  if (!pending || !pending.requestId) return
  const meta = s.currentTurn?.toolByUseId.get(toolUseId)
  const originalInput = meta?.input ?? {}
  s.proc?.sendPermissionResponse(pending.requestId, 'allow', {
    updatedInput: { ...originalInput, answers: pending.answers },
  })
  s.pendingPermissions.delete(pending.requestId)
  if (meta) {
    meta.output = JSON.stringify({ answers: pending.answers })
    meta.isError = false
  }
  s.pendingAsks.delete(toolUseId)
  if (s.pendingPermissions.size === 0 && s.status === 'awaiting_permission') {
    s.status = 'working'
  }
  // 用户答完 → 球踢回 SDK,期望模型基于 answers 推理出后续动作。
}
