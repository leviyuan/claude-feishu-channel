import type { Session } from './session'
import * as feishu from './feishu'
import { log } from './log'

type ControlCommand = 'hi' | 'stop' | 'kill' | 'restart' | 'clear' | 'compact' | 'model'

const CONTROL_COMMAND_ALIASES = new Map<string, ControlCommand>([
  ['hi', 'hi'],
  ['stop', 'stop'], ['st', 'stop'],
  ['kill', 'kill'], ['kl', 'kill'],
  ['restart', 'restart'], ['rs', 'restart'],
  ['clear', 'clear'], ['cl', 'clear'],
  ['compact', 'compact'], ['cm', 'compact'],
  ['model', 'model'], ['md', 'model'],
])

/** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
 * plus their two-letter aliases where applicable.
 * Returns true if the command was consumed (don't forward to Codex).
 * Exact match, case-insensitive, ignores trailing whitespace.
 *
 * Trade-off (user-confirmed 2026-05-15): these words are reserved
 * globally — typing "hi" as a literal greeting will show the console
 * card instead of reaching Codex. The ergonomic win (no slash, no
 * shift key, one-handed phone use) outweighs the collision in this
 * product's private-bot use case. `stop` was added 2026-05-15 once
 * auto-interrupt on mid-turn user messages was removed (matching
 * Codex's native type-ahead behavior) — explicit barge-out
 * needed a knob and `kill` (full subprocess teardown) is too heavy. */
export async function runCommand(s: Session, raw: string, userOpenId = ''): Promise<boolean> {
  const wt = raw.trim().match(/^(?:wt|worktree)(?:\s+(.+))?$/i)
  if (wt) {
    if (s.startingAgy || s.runningAgy) {
      await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 wt。')
      return true
    }
    await s.runWorktreeCommand((wt[1] ?? '').trim(), userOpenId)
    return true
  }
  // btw = 开临时会话(同目录,自动启动);bye = 散临时群;fk/fork = 列当前会话 turn 分叉;
  // bk/back = 立刻终止当前 + 列 turn 回滚(选后回滚 + 发 Write 记录卡)。
  if (raw.trim().match(/^btw$/i)) {
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 btw。'); return true }
    await s.runBtwCommand(userOpenId)
    return true
  }
  if (raw.trim().match(/^bye$/i)) {
    await s.runByeCommand()
    return true
  }
  if (raw.trim().match(/^(?:fk|fork)$/i)) {
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 fk。'); return true }
    await s.showForkList()
    return true
  }
  if (raw.trim().match(/^(?:bk|back)$/i)) {
    if (s.startingAgy || s.runningAgy) { await feishu.sendText(s.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再使用 bk。'); return true }
    // 立刻终止当前会话(保留 lastSessionId 供选后回滚),再弹回滚列表
    if (s.isRunning()) await s.stop('回滚前终止', { announce: false })
    await s.showBackList()
    return true
  }
  const agy = raw.trim().match(/^agy(?:\s+([\s\S]+))?$/i)
  if (agy) {
    await s.runAgyCommand((agy[1] ?? '').trim())
    return true
  }
  if (raw.trim().toLowerCase() === 'task') {
    await s.showTasklistPanel()
    return true
  }
  // <source>-setup <args> —— 启用某 token source(generic:路由到 source factory 的 setup.parseArgs,
  // 加新 source 不改本文件 —— 在 token-source-<name>.ts 声明 setup 字段即自动接入)。
  const tsSetup = raw.trim().match(/^(\w+)-setup\s+([\s\S]+)$/i)
  if (tsSetup) {
    const { runTokenSourceSetup } = await import('./token-source-setup')
    await runTokenSourceSetup(s, tsSetup[1].trim(), tsSetup[2].trim())
    return true
  }
  const command = CONTROL_COMMAND_ALIASES.get(raw.trim().toLowerCase())
  if (!command) return false
  if ((s.startingAgy || s.runningAgy) && !['stop', 'kill', 'restart', 'hi', 'model'].includes(command)) {
    await feishu.sendText(s.chatId, `⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再执行 ${command}。`)
    return true
  }
  switch (command) {
    case 'model':
      await s.showModelPanel()
      return true
    case 'compact':
      await s.runCompactCommand()
      return true
    case 'hi':
      {
        const needsStart = !s.isRunning()
        const backend = s.backendLabel()
        const statusCard = needsStart
          ? await s.openStatusCard('hi', s.withModel(`🚀 启动 ${backend}`))
          : null
        let lastStatus = s.withModel(`🚀 启动 ${backend}`)
        const ok = needsStart
          ? await s.start({
              announce: !statusCard,
              onStatus: status => {
                lastStatus = status
                s.setStatusCard(statusCard, status)
              },
            })
          : true
        if (!ok) {
          await s.closeStatusCard(statusCard, lastStatus.startsWith('❌') ? lastStatus : '❌ 启动失败')
          return true
        }
        if (statusCard) {
          await s.replaceStatusCardWithConsole(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
          return true
        }
        if (needsStart) {
          await s.closeStatusCard(
            statusCard,
            s.withModel(s.withWorktreeInstructionNotice(`✅ ${s.backendLabel()} 已就绪`)),
          )
        }
      }
      await s.showConsole()
      return true
    case 'stop':
      if (s.runningAgy) {
        await s.stopAgyTask('🛑 agy 已打断')
        return true
      }
      // Soft barge-out: interrupt the current turn (if any) AND drop
      // the pending-message count so a stack of type-ahead doesn't
      // refire after the interrupt. Subprocess stays alive. Note: the
      // SDK keeps its OWN internal queue of the user-text frames we
      // already sendText'd — interrupt should also flush that side,
      // but the daemon can't reach into it directly; in practice the
      // sendInterrupt() control_request causes the SDK to discard
      // queued input alongside the in-flight call.
      s.clearStaleIdleQueueState('stop')
      s.clearMultiMsgBuffer('stop command')
      if (!s.currentTurn && s.pendingUserMessageCount === 0 && s.pendingMidTurnMsgs.length === 0) {
        const statusCard = await s.openStatusCard('stop', '⚪ 当前没有正在执行的 turn', 'grey')
        if (statusCard) {
          await s.closeStatusCard(statusCard, '⚪ 无正在执行的 turn')
        } else {
          await feishu.sendText(s.chatId, '⚪ 当前没有正在执行的 turn')
        }
        return true
      }
      log(`session "${s.sessionName}": stop command — interrupt + drop count=${s.pendingUserMessageCount} midBuffer=${s.pendingMidTurnMsgs.length}`)
      // Cancelled queued msgs: remove the OneSecond (no longer waiting)
      // and stamp a CrossMark (explicit cancelled state, distinct from
      // a natural release where reactions just disappear). Cancelled
      // mid-batch msgs get the same treatment.
      // 用 `seen` Set 去重 —— mid-turn buffer 跟 pendingReactionIds 的
      // msgId 重叠(onUserMessage 进 buffer 时同时 trackReaction),
      // 两次 addReaction(CrossMark) 会在飞书侧渲染两个 ❌ (P0-1)。
      const seen = new Set<string>()
      for (const [msgId, rid] of [
        ...s.pendingReactionIds.entries(),
        ...s.currentBatchReactionIds.entries(),
      ]) {
        if (rid) void feishu.deleteReaction(msgId, rid)
        void feishu.addReaction(msgId, 'CrossMark')
        seen.add(msgId)
      }
      // Mid-turn buffer never reached SDK — cancel those too.
      for (const msg of s.pendingMidTurnMsgs) {
        if (msg.msgId && !seen.has(msg.msgId)) void feishu.addReaction(msg.msgId, 'CrossMark')
      }
      s.pendingUserMessageCount = 0
      s.pendingMidTurnMsgs = []
      s.pendingTurnInputs = []
      s.lastUserOpenId = ''
      s.pendingReactionIds = new Map()
      s.currentBatchReactionIds = new Map()
      // Tag the imminent SDK `result` so the result handler does not
      // repaint the footer after this stop path already closed the card.
      // Must be set BEFORE sendInterrupt — the result can land next tick.
      s.userInterrupted = true
      s.interrupt()
      // 主动封口,把 footer 改成 🛑 打断、停止 footer 状态计时、把 streaming_mode
      // 翻回 false,否则卡片会僵在运行中状态。SDK 的 post-interrupt
      // result 也会进 closeTurnCard,但 currentTurn 已被这里置空,那条
      // 路径会 early-return,不会重画 footer。
      await s.closeTurnCard('🛑 打断')
      return true
    case 'kill':
      {
        if (s.runningAgy) await s.stopAgyTask('🛑 agy 已终止')
        const wasRunning = s.isRunning()
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = wasRunning ? `🛑 停止 ${backend}` : '⚪ session 当前未运行'
        const statusCard = await s.openStatusCard('kill', initialStatus, wasRunning ? 'red' : 'grey')
        await s.stop('已终止', {
          announce: !statusCard,
          onStatus: status => {
            s.setStatusCard(statusCard, status)
          },
        })
        await s.closeStatusCard(statusCard, wasRunning ? `✅ ${backend} 已终止` : `⚪ ${backend} 未运行`)
      }
      return true
    case 'restart':
      // rs 优化:会话进行中 = 打断 + 弃后台 + 恢复(走下面 restart(true),它已
      // resetBackgroundTasks);claude 空闲 = 列项目最近 24h 会话选恢复(比"只恢复上一会话"实用)。
      // codex 空闲:codex 无 transcript,showResumeList→listClaudeSessions/onResumeSelect 是
      // claude-only(列不出 codex 会话、点任何项也被 provider 拦死),直接 fall-through 走
      // restart(true) resume 已按 provider 持久化的 lastSessionId(getSessionResume)。
      if (!s.isRunning() && s.selectedProvider !== 'codex') {
        await s.showResumeList()
        return true
      }
      // 进行中 / codex 空闲:resume the prior conversation — kills the current proc and
      // spawns a new one with `--resume <lastSessionId>`(放弃后台进程)。
      {
        const resumeThreadLabel = s.lastSessionId ? s.lastSessionId.slice(0, 8) : ''
        const backend = s.backendLabel(s.proc?.provider ?? s.currentProvider())
        const initialStatus = s.isRunning()
          ? s.withModel(`🔁 重启 ${backend}`)
          : resumeThreadLabel
            ? s.withModel(`🔁 恢复上一会话 thread=${resumeThreadLabel}…`)
            : s.withModel(`🔁 启动 ${backend}`)
        const statusCard = await s.openStatusCard('restart', initialStatus)
        if (s.runningAgy) {
          s.setStatusCard(statusCard, '🛑 restart 前终止 agy')
          await s.stopAgyTask('🛑 restart 前已终止 agy')
        }
        let lastStatus = initialStatus
        const ok = await s.restart(true, {
          announce: !statusCard,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        const finalStatus = ok
          ? (
              lastStatus.startsWith('✅')
                ? lastStatus
                : s.withWorktreeInstructionNotice(resumeThreadLabel ? '✅ 已恢复上一会话' : `✅ ${s.backendLabel()} 已就绪`)
            )
          : (lastStatus.startsWith('❌') ? lastStatus : '❌ 重启失败')
        await s.closeStatusCard(statusCard, ok ? s.withModel(finalStatus) : finalStatus)
      }
      return true
    case 'clear':
      // "throw away current conversation, start a new one". By design
      // this only makes sense when there IS a current conversation:
      // calling clear from stopped state is a no-op (user-confirmed
      // 2026-05-16) — we don't want a stray `clear` to silently spawn
      // a fresh session the user didn't ask for. To start from cold,
      // use `hi`.
      if (!s.isRunning()) {
        s.status = 'stopped'
        s.opts.onLifecycleChange?.()
        const statusCard = await s.openStatusCard('clear', '⚪ session 当前未运行', 'grey')
        if (statusCard) {
          await s.closeStatusCard(statusCard, `⚪ ${s.backendLabel()} 未运行，clear 无效`)
        } else {
          await feishu.sendText(s.chatId, `⚪ session "${s.sessionName}" 当前未运行,clear 无效;用 \`hi\` 启动或 \`restart\` 恢复上一会话`)
        }
        return true
      }
      {
        const statusCard = await s.openStatusCard('clear', '🧹 清空并启动新会话', 'orange')
        let lastStatus = '🧹 清空并启动新会话'
        const ok = await s.restart(false, {
          announce: !statusCard,
          onStatus: status => {
            lastStatus = status
            s.setStatusCard(statusCard, status)
          },
        })
        await s.closeStatusCard(
          statusCard,
          ok
            ? s.withModel(s.withWorktreeInstructionNotice('✅ 已清空并启动新会话'))
            : (lastStatus.startsWith('❌') ? lastStatus : '❌ 清空失败'),
        )
      }
      return true
  }
}
