/**
 * Session — 1 Feishu chat ↔ 1 Codex app-server process ↔ 1 streaming card.
 *
 * Owns the CodexProcess lifecycle, the per-turn card state machine, and
 * the in-flight permission map.  Wires Codex app-server events into Card
 * Kit ops, and wires Feishu inbound (text + card-action callbacks) into
 * Codex turns.
 *
 * Tool tracking, AskUserQuestion flow, permission rendering, command
 * routing, model/task/wt/compact panels, and agy tasks live in sibling
 * session-*.ts modules. Fields touched by those helpers carry no
 * `private` modifier — convention is "no modifier = package-internal,
 * only the session-*.ts helpers should touch it."
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  CODEX_EFFORT,
  CodexProcess,
  diffUsageTotals,
  effectiveTurnTokens,
  isCodexReasoningEffort,
  type CanUseToolRequest,
  type CodexReasoningEffort,
  type CodexUsage,
  type ContextCompactedNotification,
  type HookCallbackRequest,
  type PlanDelta,
  type TokenUsageUpdated,
  type ThreadGoal,
  type TurnPlanUpdated,
} from './codex-process'
import {
  CLAUDE_EFFORT,
  agentProviderLabel,
  isClaudeReasoningEffort,
  type AgentProcess,
  type AgentProvider,
  type AgentReasoningEffort,
  type ClaudeReasoningEffort,
} from './agent-process'
import {
  ClaudeAgentProcess,
  assertClaudeCodeAvailable,
  type BgTaskStartedEvent,
  type BgTaskProgressEvent,
  type BgTaskUpdatedEvent,
  type BgTaskSettledEvent,
} from './claude-agent-process'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { readSysInfo } from './sysinfo'
import { readUsage, updateUsageFromRateLimits, peekUsage, type UsageSnapshot } from './usage'
import { readGlmUsage, type GlmUsageSnapshot } from './glm-usage'
import {
  contextLimitFromAppServer,
  contextTokensFromUsage,
} from './context-window'
import { extractAskUsrMarkers, extractSendMarkerPaths, stripAskUsrMarkers } from './outbound-markers'
import * as sessionMultimsg from './session-multimsg'
import type { TurnState, Status, SessionOpts, LastTurnDelta, CumStats } from './session-types'
import * as sessionAgy from './session-agy'
import * as sessionTools from './session-tools'
import * as sessionAsk from './session-ask'
import * as sessionHostAsk from './session-host-ask'
import * as sessionPermission from './session-permission'
import {
  messageOf,
  type FooterTimer,
  type LifecycleProgressOpts,
  type ModelActionResult,
  type StatusCardHandle,
  type TasklistActionResult,
  type WorktreeActionResult,
} from './session-util'
import * as sessionCommands from './session-commands'
import * as sessionCompact from './session-compact'
import * as sessionModel from './session-model'
import * as sessionTasklist from './session-tasklist'
import * as sessionWorktree from './session-worktree'

export type { SessionOpts } from './session-types'

function compactionKey(notice: ContextCompactedNotification): string {
  return notice.itemId || notice.turnId || '__latest__'
}

function latestPendingCompactionKey(turn: TurnState): string | null {
  let key: string | null = null
  for (const k of turn.contextCompactionPending.keys()) key = k
  return key
}

function mergeCompactionNotices(
  start: ContextCompactedNotification | undefined,
  end: ContextCompactedNotification,
): ContextCompactedNotification {
  if (!start) return end
  return { ...start, ...end, phase: 'end' }
}

const FOOTER_STATUS_TICK_MS = 1000
/** 后台游标卡周期刷新间隔:无 task_progress 事件的 shell 后台任务(如 codex exec)靠
 *  这个 tick 定时 replaceElement 刷 panel header 的运行时长,否则冻在开卡那刻。 */
const BACKGROUND_REFRESH_TICK_MS = 2000
const FOOTER_THINKING_PREFIX = 'Thinking...'
const FOOTER_WRITING = 'Writing...'
const FOOTER_WORKING = 'Working...'
const RESUME_INIT_NOTICE_MS = 10_000
const RESUME_INIT_TIMEOUT_MS = 120_000
/** Soft cap on element count per Feishu card before we proactively
 * rotate to a fresh one. The hard ceiling is NOT ~100 as once assumed:
 * a 2026-05-23 dogfood turn hit `300305 [element exceeds the limit]` at
 * ~76 elements (tool_60 + assistant_13 + base). The old soft cap of 80
 * sat ABOVE the real ceiling, so `getElementCount() >= 80` never became
 * true before Feishu rejected the add — rotation never fired and the card
 * froze mid-turn. Keep this comfortably under the observed ~75; 50 leaves
 * headroom for in-flight stream handlers that already chose the old cardId
 * before this check fired, and for heavier element mixes that trip the
 * limit earlier. This number is no longer the only line of defense:
 * addElement's 300305/300315 now forces a rotate directly (see
 * Session.onCardWriteFailure), so a wrong guess here still self-heals. */
const CARD_ELEMENT_SOFT_LIMIT = 50

/** Max mid-turn card rotations per turn. Past this we stop opening fresh
 * cards and fall back to log-only for the rest of the turn. Guards the
 * "rotate on any write failure" path against a runaway loop where every
 * card keeps failing (Feishu outage, or an element whose own content
 * Feishu rejects on every card) — without a cap that would spray an
 * endless trail of empty cards into the chat. */
const MAX_MIDTURN_ROTATES = 5
/** Claude Agent SDK does not emit stream `init` until the first user input.
 * Still give synchronous/early startup failures a chance to surface before
 * presenting the session as ready. */
const CLAUDE_STARTUP_GRACE_MS = 250

function timedStatus(status: string, startedAt: number): string {
  const elapsedS = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return `${status} (${elapsedS}s)`
}

export class Session {
  /** Process-wide registry of every Session ever constructed in this daemon.
   * Used by the `hi` console panel to enumerate sibling sessions across
   * Feishu groups. Sessions are never removed (matches the daemon's
   * `sessions` map lifecycle — one Session per chat for the daemon's
   * lifetime). Callers should filter on `isRunning()` when they only
   * want currently-alive Codex processes. */
  static readonly all: Set<Session> = new Set()

  // ── package-internal state (touched by session-*.ts helpers) ──
  proc: AgentProcess | null = null
  currentTurn: TurnState | null = null
  /** 已确认后台的任务(workflow/monitor 白名单,或收到 is_backgrounded:true 提升)。
   *  驱动后台游标卡渲染。以 task_id 为 key,跨 turn 累积 —— 后台任务生命周期
   *  不受 turn 边界约束。 */
  backgroundTasks: cards.BgTaskEntry[] = []
  /** 观察池:task_started 进来但还没后台化的前台 task(Bash 命令/前台子 agent)。
   *  不渲染;等 task_updated.is_backgrounded=true 提升到 backgroundTasks,或
   *  task_settled 时丢弃。治「随便跑个命令就冒一项后台任务」的关键。 */
  pendingBgTasks: cards.BgTaskEntry[] = []
  /** 后台游标卡句柄。null = 当前无活卡(从未建/已沉降/已固化)。活卡期间
   *  streaming 开,replaceElement body 刷新任务行。卡吸附在对话末尾,被新消息
   *  超越时沉降(updateCard),只在全部终态时固化留在原地。 */
  backgroundCard: { messageId: string; cardId: string } | null = null
  /** task_progress 风暴的刷新节流 timer。 */
  private backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /** 后台卡周期 tick:每 BACKGROUND_REFRESH_TICK_MS 刷一次活跃任务的 header 时长,
   *  治无 task_progress 的 shell 后台任务时长冻结。活卡期间常驻,沉降/迁移时清。 */
  private backgroundRefreshTick: ReturnType<typeof setInterval> | null = null
  /** openBackgroundCard 进行中标记 —— 防止并发 bg_task 事件在 await sendCard
   *  期间重复开卡(sendCard 未返回前 backgroundCard 仍 null,第二个事件会再开一张)。 */
  private openingBackground = false
  /** 已 addElement 到活卡的 task panel 的 task_id 集合。新任务 diff 出来才
   *  addElement(避免重复 add);已有任务 replaceElement 整个 panel。 */
  private backgroundDetailAdded = new Set<string>()
  /** 最近一次主线程 Task tool_use 的 id —— SDK 若在 task_started 里没填 tool_use_id,
   *  用它兜底关联子 agent 消息的 parent_tool_use_id 到对应 task。 */
  private lastMainTaskToolUseId: string | null = null
  /** onUserMessage 沉降旧卡后置位;主卡落地后据此重建后台卡(游标重回末尾)。 */
  private pendingRebuildBackgroundCard = false
  /** turn 收尾后有后台任务结算 → SDK 会自发开一轮恢复轮(task_notification
   *  合并结果),该轮 init 没有伴随用户消息。置位后,下一个无用户批次的 init
   *  据此开 bg_task_resume 卡承接输出;任何 turn 开卡即消费(结算通知会被
   *  并入那一轮),避免陈旧标记把无关的空 init 误判成恢复轮。 */
  private bgResumePending = false
  /** 无 currentTurn 时到达的 assistant 正文(恢复轮开卡前的窗口期 / 开卡
   *  失败)。openTurnCard 落地时并入新卡;result/exit 时纯文本兜底推送。
   *  决不静默丢弃(2026-07-04 etmmo 终报告事故:恢复轮 6.6KB 合并终报告
   *  整轮无卡,appendAssistant 首行 return 全部丢光,飞书无痕)。
   *  只在"合法无卡窗口"缓冲(openingTurn 正在开卡 / bgResumeCardless 恢复轮
   *  开卡失败续窗);其余无卡场景(被打断的轮尾、kill 窗口残字)一律丢弃,
   *  否则会被错误推送或并入下一张不相干的卡。 */
  private orphanAssistantSegments: string[] = []
  private orphanAssistantCurrent = ''
  /** 恢复轮 openTurnCard 失败后置位:该轮此后再无卡,正文继续进孤儿缓冲直到
   *  result 纯文本兜底。区别于 openingTurn(仅开卡 await 窗口)。 */
  private bgResumeCardless = false
  /** result 抢在 openTurnCard 的 sendCard/id_convert await 窗口内到达 →
   *  置位;开卡 IIFE 落地后据此立即收尾,避免卡片永远悬挂、session 卡在
   *  working(旧代码对 user turn 也有此隐患,这里一并收口)。 */
  private sawResultWhileOpening = false
  pendingPermissions = new Map<string, { toolUseId: string; permissionSuggestions?: unknown }>()
  /** Open AskUserQuestion tool calls — keyed by tool_use_id. Codex and
   * Claude both route AskUserQuestion through the can_use_tool flow;
   * we have to thread the permission `requestId` through here so the
   * answer (option click OR custom text submit) can resolve the
   * permission with `updatedInput.answers` populated.
   * `deferredAnswer` covers the race where the user clicks/submits
   * BEFORE can_use_tool arrives (addTool fires on the assistant
   * message; can_use_tool is a separate control_request that lands
   * slightly later). */
  pendingAsks = new Map<string, {
    questions: cards.AskQuestion[]
    i: number
    requestId?: string
    /** 累计答案 — key 是 question 原文 (SDK 把这条 record 格式
     * 化进 tool_result), value 是用户选的 option label 或自定
     * 义文字。全部 question 都答完时一并塞进 updatedInput.answers
     * 发回 SDK。 */
    answers: Record<string, string>
    /** 已答详情 (按 question idx 索引)，用来给历史面板和 terminal
     * 状态画选中态。answers 同步累计，但这里多保留 customText /
     * optionIdx 字段以便 UI 区分两种回答路径。 */
    answered: Map<number, cards.AskAnswered>
    /** 当前展示的 question idx。undefined 表示全部答完 (terminal)
     * —— 这时若 requestId 已就位则 finalize；否则等 renderPermission
     * 一来立即 finalize。 */
    currentIdx?: number
  }>()
  /** Host-side askusr cards triggered by assistant marker protocol.
   * Kept separate from SDK AskUserQuestion because there is no
   * can_use_tool/requestId handshake here — the host injects the
   * synthetic tool call/tool result into thread history after the user
   * answers, then starts a fresh continuation turn. */
  pendingHostAsks = new Map<string, {
    questions: cards.AskQuestion[]
    answered: Map<number, cards.AskAnswered>
    currentIdx?: number
    toolCallId: string
    inputJson: string
    cardId?: string
    messageId?: string
    creatingCard?: boolean
    resumeStarted?: boolean
  }>()
  /** Thread-scoped goal reported by Codex app-server. Pure progress
   * accounting updates refresh this snapshot without adding card elements;
   * only objective/status/budget changes are rendered. */
  currentGoal: cards.ThreadGoal | null = null
  status: Status = 'stopped'

  // ── strictly private state ──
  /** Count of user messages we've sent to Codex since the last
   * turn opened on our side. NOT a FIFO of individual messages — the SDK
   * USUALLY batch-merges every mid-turn user message into a single
   * combined turn once the in-flight turn finishes, so most of the time
   * the daemon observes **one** init event per batch. Tracking a count +
   * last-sender (rather than an Array<msg>) keeps the daemon's view
   * loosely in sync with the SDK's dequeue semantics. Caveat verified
   * 2026-05-17 (test1 accumulator, 8-message rapid-fire): when the first
   * write lands in an idle SDK, that single msg gets its own turn and
   * the rest merge into a second turn — i.e. 1+(N-1) split, not always
   * one merge. To stay coherent with this, `drainMidTurnAndOpen` bumps
   * the count by `batch.length` up front (covering both the first solo
   * turn and the eventual merged tail), and the init handler resets to
   * 0 on the first claim. If the SDK takes the merge path, the bail at
   * `currentTurn=yes` in the init handler leaves pendingCount stale (>0)
   * until the GC at the next `onUserMessage`; if it takes the split
   * path, the second init sees pendingCount>0 and correctly classifies
   * the trailing batch as user-batch. */
  pendingUserMessageCount = 0
  /** Mid-turn user messages buffered DAEMON-SIDE (not yet sendUserText'd
   * to the SDK). Drained in the `result` handler by writing each to SDK
   * stdin, which doubles as the wake signal the Codex app-server needs
   * to start the next batch turn (it won't auto-dequeue queued
   * type-ahead msgs after `result` — confirmed in dogfood testing).
   * Buffering also keeps mid-turn msgs out
   * of any AskUserQuestion `QUEUE remove` storm, since they were never
   * in the SDK queue to begin with. */
  pendingMidTurnMsgs: Array<{ text: string; wireText: string; userOpenId: string; msgId: string }> = []
  /** 下一个 turn 的 user inputs 暂存区。所有 sendUserText 的 wireText 在
   * sendUserText 之前 push 这里;openTurnCard 创建 turn 时一次性取走 + clear。
   * mainConversationCard 把这些 wireText 渲染成顶部"📥 收到 (N)"折叠面板,
   * 让用户在卡片自己里就能看到这一轮触发了什么(不必滚群里找原消息)。
   * mid-turn buffer 的消息不在这里 push —— 它们走 drainMidTurnAndOpen 那条
   * 路径,drain 时统一 push。 */
  pendingTurnInputs: string[] = []
  /** 用户用 `>>>`(≥3 个 >)主动开启的多条消息缓冲。null = 当前不在多条
   *  收集模式;非 null = 正在累积,直到 `<<<`(≥3 个 <)收尾合并成一条
   *  onUserMessage。跟 pendingMidTurnMsgs 不同:后者是 turn 进行中被动到达
   *  的排队,这个是用户显式分段。状态机在 session-multimsg.ts,永不超时。*/
  multiMsgBuffer: sessionMultimsg.MultiMsgSegment[] | null = null
  /** multiMsgBuffer 里每条消息上挂的 📌 reaction_id('' = addReaction 还在
   *  飞)。flush 时释放 📌,clear 时换成 ❌。*/
  multiMsgReactions = new Map<string, string>()
  /** Most recent userOpenId seen via `onUserMessage`. Used only when a
   * merged batch fires its init event and the daemon needs *some* open_id
   * to scope the eventual `urgent_app` push — there's no obviously right
   * answer when N messages from possibly different users collapse into
   * one turn, and "the most recent sender" is a defensible default for
   * the single-user private-bot scenario this product targets. */
  lastUserOpenId = ''
  /** Feishu message_ids of user messages that arrived while the daemon
   * was busy (turn in flight or mid-open), mapped to the `reaction_id`
   * of the `OneSecond` reaction placed at arrival. The reaction_id is
   * what `deleteReaction` needs to *remove* the OneSecond once the
   * message has been absorbed by the SDK (either system-reminder
   * injection mid-turn or a merged-batch dequeue on next turn).
   * User feedback (2026-05-15): replacing OneSecond with a second
   * CheckMark stacked two emojis on the same row; cleaner UX is
   * "queued → released" via removal, not "queued → done" via
   * stacking. */
  pendingReactionIds = new Map<string, string>()
  /** Snapshot of `pendingReactionIds` taken when the init handler
   * claims a merged batch — these are the Feishu messages whose
   * OneSecond reactions are the currently-open turn's responsibility
   * to clear (via deleteReaction). Empty for eager-opened solo turns. */
  currentBatchReactionIds = new Map<string, string>()
  /** Count of `system/init` events seen this subprocess. The first one is
   * the boot init (claimed by whichever user message lands first); later
   * ones can mark the start of SDK-driven queued user message draining.
   * Reset on stop/restart/exit
   * since `init` re-fires after every spawn. */
  private initCount = 0
  /** Sync guard set before any `await` in the eager-open path of
   * `onUserMessage`, cleared after `currentTurn` is set. Closes the race
   * where an SDK-emitted `init` event lands during the eager open's
   * Feishu API await — without this, the init handler would observe
   * `currentTurn === null && queue empty` (we've already shifted) and
   * incorrectly open a second card for the same user message. The flag
   * tells the init handler "an eager open is already
   * claiming the slot, stand down". */
  openingTurn = false
  private turnCounter = 0
  /** One-shot: user invoked `stop` during the current turn. Set right
   * before `sendInterrupt`; consumed by the next `result` handler so it
   * does not overwrite the 🛑 footer already painted by the stop path.
   * Reset by exit handler for the proc-died-before-result case. */
  userInterrupted = false
  // Last known resumable thread id. Persisted once a turn starts, so
  // `restart` can resume an in-flight conversation even if the daemon
  // exits before the turn finishes.
  lastSessionId: string | null = null
  selectedProvider: AgentProvider = 'claude'
  selectedModel: string | null = null
  selectedEffort: AgentReasoningEffort | null = null
  modelPanels = new Map<string, sessionModel.ModelPanelState>()
  private startedAt: number = 0
  private cumStats: CumStats = { tokens: 0, costUsd: 0, turns: 0 }
  private lastTurnDelta: LastTurnDelta | null = null
  private currentTurnUsageBaseline: CodexUsage | null = null
  private currentTurnUsageBaselineKnown = false
  private lastTurnUsage: CodexUsage | null = null
  /** Resume path can restore a historical thread without replaying its
   * absolute token totals into the new subprocess. Until we observe one
   * fresh absolute total snapshot, the next turn's baseline is unknown
   * and must not be guessed as zero. */
  private usageTotalsSeedUnknown = false
  /** Set while the `compact` command owns a status card for a standalone
   * compaction. Suppresses the generic no-turn compaction text alert;
   * command feedback is rendered on that status card instead. */
  manualContextCompactionPending = false
  runningAgy: sessionAgy.AgyTaskState | null = null
  startingAgy = false
  agyForwardPrompts = new Map<string, sessionAgy.AgyForwardRecord>()
  /** Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板。codex
   * 的 TodoWrite 一次就带完整列表,直接渲染即可;但 Claude Code 把它拆成 4
   * 个单点工具,只有 TaskList 才有完整快照。这里跨 turn / rotate 累积一份
   * 以 task id 为 key 的 board(官方 todo-tracking 文档推荐的做法),每次 Task
   * 工具完成时由 session-tools.ts 调 applyTaskTool 更新,渲染整个 board 而非
   * 孤立的单条 —— 见 cards/task-board.ts。 */
  taskBoard: cards.TaskBoardEntry[] = []

  constructor(
    public readonly sessionName: string,
    public readonly chatId: string,
    public opts: SessionOpts = {},
  ) {
    Session.all.add(this)
    const selection = feishu.getSessionModelSelection(sessionName)
    this.selectedProvider = selection?.provider ?? 'claude'
    this.selectedModel = selection?.model ?? null
    this.selectedEffort = selection?.effort ?? null
    // model 命令已二元化:历史持久化的非固定值归一到固定两项,避免旧
    // session-model-map 把 session 带到已下线的 profile(如 claude:deepseek)。
    // 仅在有持久化选择时归一;无选择(默认)保持 null,交给 spawn 默认逻辑。
    if (selection) {
      if (this.selectedProvider === 'claude' && this.selectedModel !== 'claude:glm') {
        this.selectedModel = 'claude:glm'
        this.selectedEffort = 'max'
      } else if (this.selectedProvider === 'codex' && this.selectedModel !== 'gpt-5.5') {
        this.selectedModel = 'gpt-5.5'
        this.selectedEffort = 'xhigh'
      }
    }
    if (this.selectedModel) {
      log(`session "${sessionName}": restored selected provider=${this.selectedProvider} model=${this.selectedModel} effort=${this.selectedEffort ?? 'unset'}`)
    }
    // Restore last-known thread/session id for the selected backend from
    // disk so a daemon restart (systemctl, crash, watchdog) doesn't
    // strand the user with a fresh conversation when they next type
    // `restart`.
    this.lastSessionId = feishu.getSessionResume(sessionName, this.selectedProvider)
    if (this.lastSessionId) {
      log(`session "${sessionName}": restored ${this.selectedProvider} lastSessionId=${this.lastSessionId.slice(0, 8)}…`)
    }
  }

  /** Minimal cross-chat snapshot for the `hi` peer-list section.
   * `startedAt` stays private so this is the documented read path. */
  peerSnapshot(): { name: string; status: Status; uptimeMs?: number } {
    return {
      name: this.sessionName,
      status: this.status,
      uptimeMs: this.startedAt ? (Date.now() - this.startedAt) : undefined,
    }
  }

  get workDir(): string {
    const override = feishu.projectProfile(this.sessionName)?.cwd
    return override && override.trim() ? override : join(feishu.PROJECTS_ROOT, this.sessionName)
  }
  isRunning(): boolean { return !!this.proc && this.proc.isAlive() }
  currentProvider(): AgentProvider { return this.selectedProvider }

  hasRunningPeerSession(sessionName: string): boolean {
    return [...Session.all].some(s => s.sessionName === sessionName && s.isRunning())
  }

  private modelForSpawn(): string | undefined {
    return this.selectedModel ?? undefined
  }

  effortForSpawn(): CodexReasoningEffort {
    return this.selectedProvider === 'codex' && isCodexReasoningEffort(this.selectedEffort)
      ? this.selectedEffort
      : CODEX_EFFORT
  }

  claudeEffortForSpawn(): ClaudeReasoningEffort {
    return this.selectedProvider === 'claude' && isClaudeReasoningEffort(this.selectedEffort)
      ? this.selectedEffort
      : CLAUDE_EFFORT
  }

  currentModelLabel(): string | null {
    return this.selectedModel ?? this.proc?.lastModel ?? null
  }

  currentEffortLabel(): AgentReasoningEffort {
    return this.selectedEffort
      ?? this.proc?.lastEffort
      ?? (this.selectedProvider === 'claude' ? CLAUDE_EFFORT : CODEX_EFFORT)
  }

  private modelEffortLabel(): string {
    const model = this.currentModelLabel()
    const effort = this.currentEffortLabel()
    return model ? `${model}/${effort}` : effort
  }

  withModel(text: string): string {
    const label = this.modelEffortLabel()
    return text.includes(label) ? text : `${text} · ${label}`
  }

  private replaceFooterContent(cardId: string, content: string): Promise<void> {
    return cardkit.replaceElement(cardId, cards.ELEMENTS.footer, {
      tag: 'markdown',
      element_id: cards.ELEMENTS.footer,
      content: content.trim() || ' ',
    })
  }

  private modelLine(): string {
    const model = this.currentModelLabel()
    const effort = this.currentEffortLabel()
    // claude 路径:provider 已显示 "Claude",model 去掉 "claude:" 前缀,
    // 否则 footer 会变成 "Claude · claude:GLM-5.2[1m]/max" 两个 claude。
    const shownModel = this.selectedProvider === 'claude'
      ? model?.replace(/^claude:/i, '')
      : model
    const label = shownModel ? `${shownModel}/${effort}` : effort
    return this.selectedProvider === 'claude' ? `${agentProviderLabel(this.selectedProvider)} · ${label}` : label
  }

  backendLabel(provider: AgentProvider = this.selectedProvider): string {
    return agentProviderLabel(provider)
  }

  private spawnAgent(resumeSessionId?: string): AgentProcess {
    if (this.selectedProvider === 'claude') {
      assertClaudeCodeAvailable()
      return new ClaudeAgentProcess({
        workDir: this.workDir,
        model: this.modelForSpawn(),
        effort: this.claudeEffortForSpawn(),
        resumeSessionId,
        appendSystemPrompt: this.spawnDeveloperInstructions(),
        profile: feishu.projectProfile(this.sessionName),
      })
    }
    return new CodexProcess({
      workDir: this.workDir,
      model: this.modelForSpawn(),
      effort: this.effortForSpawn(),
      resumeSessionId,
      appendSystemPrompt: this.spawnDeveloperInstructions(),
    })
  }

  async applyModelSelection(
    provider: AgentProvider,
    model: string,
    effort: AgentReasoningEffort | null,
  ): Promise<void> {
    this.selectedProvider = provider
    this.selectedModel = model
    this.selectedEffort = effort
    this.lastSessionId = feishu.getSessionResume(this.sessionName, provider)
    feishu.bindSessionModel(this.sessionName, provider, model, effort)
    await this.stopIdleMismatchedProcess()
  }

  async stopIdleMismatchedProcess(): Promise<void> {
    if (!this.proc?.isAlive()) return
    if (this.proc.provider === this.selectedProvider) return
    if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) return
    const proc = this.proc
    log(`session "${this.sessionName}": stop idle ${proc.provider} process after switching to ${this.selectedProvider}`)
    this.proc = null
    this.initCount = 0
    // 进程换掉:恢复轮标记 / 孤儿缓冲随旧进程作废,否则会泄漏到新进程的
    // boot init,把一次干净启动误判成 bg_task_resume 轮开出幽灵卡。
    this.bgResumePending = false
    this.sawResultWhileOpening = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    this.opts.onLifecycleChange?.()
    await proc.kill(1000)
  }

  async stopIdleCurrentProcess(reason: string): Promise<boolean> {
    if (!this.proc?.isAlive()) return false
    if (this.currentTurn || this.openingTurn || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0) return false
    const proc = this.proc
    log(`session "${this.sessionName}": stop idle ${proc.provider} process: ${reason}`)
    this.proc = null
    this.initCount = 0
    this.bgResumePending = false
    this.sawResultWhileOpening = false
    this.discardOrphanAssistant()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    this.opts.onLifecycleChange?.()
    await proc.kill(1000)
    return true
  }

  private startFooterTimer(
    cardId: string,
    initialStatus: string,
    renderContent: (status: string) => string = status => status,
  ): FooterTimer {
    const startedAt = Date.now()
    let status = initialStatus
    let stopped = false
    const render = (): void => {
      if (stopped) return
      void this.replaceFooterContent(cardId, renderContent(timedStatus(status, startedAt)))
    }
    const handle = setInterval(render, FOOTER_STATUS_TICK_MS)
    render()
    return {
      setStatus(next: string): void {
        status = next
        render()
      },
      stop(): void {
        if (stopped) return
        stopped = true
        clearInterval(handle)
      },
      elapsedSec(): string {
        return ((Date.now() - startedAt) / 1000).toFixed(1)
      },
    }
  }

  async openStatusCard(
    title: string,
    initialStatus: string,
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'turquoise' = 'blue',
  ): Promise<StatusCardHandle | null> {
    const startedAt = Date.now()
    const card = cards.statusCard({
      sessionName: this.sessionName,
      title,
      status: timedStatus(initialStatus, startedAt),
      template,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": status card send failed title=${title}`)
      await feishu.sendTextRaw(this.chatId, `❌ 创建状态卡片失败: ${title}`)
      return null
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) {
      log(`session "${this.sessionName}": status card id_convert failed title=${title}: ${e}`)
      await feishu.sendTextRaw(this.chatId, `❌ 状态卡片初始化失败: ${title}`)
      return null
    }
    cardkit.recordCardCreated(cardId, 1)
    return {
      cardId,
      title,
      timer: this.startFooterTimer(
        cardId,
        initialStatus,
        status => cards.statusCardContent(title, status),
      ),
    }
  }

  setStatusCard(handle: StatusCardHandle | null, status: string): void {
    handle?.timer.setStatus(status)
  }

  async closeStatusCard(handle: StatusCardHandle | null, finalStatus: string): Promise<void> {
    if (!handle) return
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const content = cards.statusCardContent(handle.title, `${finalStatus} (${elapsed}s)`)
    await cardkit.flush(handle.cardId)
    await this.replaceFooterContent(handle.cardId, content)
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    await cardkit.dispose(handle.cardId)
  }

  beginAgyForwardToCodex(resultIdRaw: string, userOpenId = ''): ModelActionResult {
    return sessionAgy.beginAgyForwardToCodex(this, resultIdRaw, userOpenId)
  }

  runAgyCommand(prompt: string): Promise<void> {
    return sessionAgy.runAgyCommand(this, prompt)
  }

  stopAgyTask(status = '🛑 agy 已打断'): Promise<boolean> {
    return sessionAgy.stopAgyTask(this, status)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  private resetFreshConversationState(): void {
    this.turnCounter = 0
    this.currentGoal = null
    this.cumStats = { tokens: 0, costUsd: 0, turns: 0 }
    this.lastTurnDelta = null
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.lastTurnUsage = null
    this.usageTotalsSeedUnknown = false
  }

  async start(opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const announce = opts.announce ?? true
    const report = opts.onStatus
    if (this.isRunning()) {
      if (this.proc?.provider === this.selectedProvider) {
        report?.(this.withModel(`✅ ${this.backendLabel()} 已运行`))
        return true
      }
      await this.stopIdleMismatchedProcess()
      if (this.proc?.isAlive()) {
        report?.(`⚠️ 当前 ${this.backendLabel(this.proc.provider)} turn 尚未结束，模型切换将在后续新 turn 生效`)
        return true
      }
    }
    if (this.selectedProvider === 'codex') report?.('🔎 检查 Codex 登录')
    else report?.('🔎 检查 Claude Code')
    if (this.selectedProvider === 'codex' && !feishu.isOpenAIChatGPTAuthenticated()) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.('❌ Codex 未登录 ChatGPT 账号')
      if (announce) {
        await feishu.sendText(this.chatId, '❌ Codex 未登录 ChatGPT 账号。\n请在服务器上运行 `codex login` 后再试。')
      }
      return false
    }
    if (!existsSync(this.workDir)) {
      report?.(`🆕 创建项目目录 ~/${this.sessionName}`)
      if (announce) await feishu.sendText(this.chatId, `🆕 目录 ~/${this.sessionName} 不存在，正在创建…`)
      try { feishu.provisionProject(this.workDir) }
      catch (e) {
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        report?.(`❌ 创建项目失败: ${e}`)
        if (announce) await feishu.sendText(this.chatId, `❌ 创建项目失败: ${e}`)
        return false
      }
    }

    if (!opts.freshConversationStateAlreadyReset) this.resetFreshConversationState()
    this.status = 'starting'
    report?.(this.withModel(`🚀 启动 ${this.backendLabel()}`))
    let proc: AgentProcess
    try {
      proc = this.spawnAgent()
    } catch (e) {
      const message = `${this.backendLabel()} 启动失败: ${messageOf(e)}`
      log(`session "${this.sessionName}": ${message}`)
      report?.(`❌ ${message}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${message}`)
      this.proc = null
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    this.proc = proc
    this.wireProc(this.proc)
    const backend = this.backendLabel()
    const initWait = this.selectedProvider === 'claude'
      ? this.waitForProcEarlyFailure(this.proc, CLAUDE_STARTUP_GRACE_MS)
      : this.waitForProcInit(this.proc, 5000)
    report?.(this.selectedProvider === 'claude'
      ? `⏳ 检查 ${backend} 启动`
      : `⏳ 等待 ${backend} init`)
    this.proc.sendInitialize()
    // Codex: 等 `system/init` 落地再认定 ready —— sendInitialize 只把 RPC
    // 写进 app-server 之前 proc.sessionId 还是 null,这时候 showConsole()
    // 看到 null 会 fallback 到磁盘上**上一次**会话的 lastSessionId,
    // 面板就把陈年 thread_id 当成"当前会话"贴出去。
    //
    // Claude: SDK 的 streaming-input 模式在第一条 user message 到达前
    // 不发 stream `init`。这里不能硬等 init,否则 `hi` 和冷启动首条消息
    // 都会超时;只短暂等待同步/早期 error 或 exit,首条输入触发的 init
    // 仍由 wireProc 正常处理。监听必须先于 sendInitialize 注册,否则
    // Claude wrapper 内同步暴露的启动失败会被错过。
    const init = await initWait
    if (init.state === 'error' || init.state === 'exit') {
      const detail = init.error ? messageOf(init.error) : init.state
      log(`session "${this.sessionName}": ${this.selectedProvider} init failed: ${detail}`)
      report?.(`❌ ${backend} 启动失败: ${detail}`)
      if (announce) await feishu.sendText(this.chatId, `❌ ${backend} 启动失败: ${detail}`)
      await this.proc?.kill(1000).catch(() => {})
      this.proc = null
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      return false
    }
    if (init.state === 'timeout') {
      log(`session "${this.sessionName}": ${this.selectedProvider} init wait timeout (5s)`)
      report?.(this.withModel(this.withWorktreeInstructionNotice(`⏳ ${backend} 已启动，init 确认超时`)))
    }

    if (announce) {
      const modelLine = this.modelLine()
      await feishu.sendText(this.chatId, [
        this.withWorktreeInstructionNotice(`✅ Lodestar session "${this.sessionName}" 已就绪，发消息开始对话。`),
        modelLine,
      ].filter(Boolean).join('\n'))
    }
    this.status = 'idle'
    this.startedAt = Date.now()
    this.opts.onLifecycleChange?.()
    report?.(this.withModel(this.withWorktreeInstructionNotice(`✅ ${this.backendLabel()} 已就绪`)))
    return true
  }

  private async waitForProcInit(
    proc: AgentProcess,
    timeoutMs: number,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'timeout'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'timeout', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  private async waitForProcEarlyFailure(
    proc: AgentProcess,
    graceMs: number,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'ready'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'ready', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const timer = setTimeout(() => finish('ready'), graceMs)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  private async waitForProcResumeInit(
    proc: AgentProcess,
    onStillWaiting: () => void,
  ): Promise<{ state: 'init' | 'error' | 'exit' | 'timeout'; error?: unknown }> {
    return await new Promise(resolve => {
      let settled = false
      const finish = (state: 'init' | 'error' | 'exit' | 'timeout', error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(noticeTimer)
        clearTimeout(timeoutTimer)
        proc.off('init', onInit)
        proc.off('error', onError)
        proc.off('exit', onExit)
        resolve({ state, error })
      }
      const noticeTimer = setTimeout(() => {
        if (!settled) onStillWaiting()
      }, RESUME_INIT_NOTICE_MS)
      const timeoutTimer = setTimeout(() => {
        finish('timeout', new Error(`resume init timed out after ${RESUME_INIT_TIMEOUT_MS / 1000}s`))
      }, RESUME_INIT_TIMEOUT_MS)
      const onInit = () => finish('init')
      const onError = (e: unknown) => finish('error', e)
      const onExit = (e: unknown) => finish('exit', e)
      proc.once('init', onInit)
      proc.once('error', onError)
      proc.once('exit', onExit)
    })
  }

  /** Drop every ⏳ OneSecond reaction this session is currently holding
   * on user chat messages, then empty the two tracking maps. Used by
   * every tear-down path (proc exit, kill, restart) so reactions don't
   * outlive the conversation that placed them — without this, a Codex
   * crash / daemon SIGTERM leaves orphan ⏳ stuck on user messages until
   * Feishu's UI eventually GCs them (which it doesn't, in practice).
   * closeTurnCard has its own release pass (with the slightly-early
   * merged-batch trade-off documented there); this is the catastrophic-
   * exit pass. Direct `deleteReaction` calls are fire-and-forget and
   * swallow their own failures (see feishu.deleteReaction). */
  private releaseAllReactions(): void {
    for (const [msgId, rid] of [
      ...this.pendingReactionIds.entries(),
      ...this.currentBatchReactionIds.entries(),
    ]) {
      if (rid) void feishu.deleteReaction(msgId, rid)
    }
    this.pendingReactionIds = new Map()
    this.currentBatchReactionIds = new Map()
  }

  clearStaleIdleQueueState(reason: string): void {
    if (this.initCount < 1 || this.currentTurn || this.openingTurn || this.pendingUserMessageCount === 0) return
    log(`session "${this.sessionName}": clear stale pending queue before ${reason} pendingCount=${this.pendingUserMessageCount} reactions=${this.pendingReactionIds.size}`)
    this.pendingUserMessageCount = 0
    // Release stale ⏳ reactions left on the abandoned batch's chat
    // messages. addReaction callbacks still in flight will fall through
    // to the orphan path in onUserMessage's trackReaction helper.
    for (const [m, rid] of this.pendingReactionIds) {
      if (rid) void feishu.deleteReaction(m, rid)
    }
    this.pendingReactionIds = new Map()
  }

  async stop(reason = '已终止', opts: LifecycleProgressOpts = {}): Promise<void> {
    const announce = opts.announce ?? true
    const report = opts.onStatus
    const stoppedAgy = await this.stopAgyTask(`🛑 ${reason}`)
    if (!this.proc) {
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      report?.(stoppedAgy ? `✅ ${reason}` : '⚪ session 当前未运行')
      if (announce && !stoppedAgy) await feishu.sendText(this.chatId, `⚪ session "${this.sessionName}" 当前未运行`)
      return
    }
    report?.(`🛑 停止 ${this.backendLabel(this.proc.provider)}`)
    // Flip lifecycle state SYNCHRONOUSLY before awaiting kill — daemon's
    // SIGTERM cleanup snapshots `isRunning()` and if we're still mid-
    // `proc.kill()` await it'll see proc!=null and write us into the
    // alive marker, which makes the next boot auto-revive a session
    // the user explicitly killed. Reordering the null-out fixes that
    // race (bug observed 2026-05-15: `kill` immediately followed by
    // `systemctl restart` revived the killed session on boot).
    log(`session "${this.sessionName}": stop (${reason})`)
    const proc = this.proc
    this.proc = null
    this.stopFooterStatus(this.currentTurn)
    this.currentTurn = null
    this.clearMultiMsgBuffer('stop')
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    this.bgResumePending = false
    this.sawResultWhileOpening = false
    // 用户主动停止:孤儿缓冲随轮作废,不兜底推送。
    this.discardOrphanAssistant()
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    this.usageTotalsSeedUnknown = false
    this.status = 'stopped'
    this.opts.onLifecycleChange?.()
    await proc.kill()
    report?.(`✅ ${reason}`)
    if (announce) await feishu.sendText(this.chatId, `🔴 ${reason} (session: ${this.sessionName})`)
  }

  async restart(resume = false, opts: LifecycleProgressOpts = {}): Promise<boolean> {
    const announce = opts.announce ?? true
    let report = opts.onStatus
    const prevSessionId = this.lastSessionId
    const prevThreadLabel = prevSessionId ? prevSessionId.slice(0, 8) : ''
    let statusCard: StatusCardHandle | null = null
    if (!report && announce && resume && prevSessionId) {
      const initialStatus = this.proc
        ? this.withModel(`🔁 重启 ${this.backendLabel(this.proc.provider)}`)
        : this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}…`)
      statusCard = await this.openStatusCard('restart', initialStatus)
      if (statusCard) report = status => this.setStatusCard(statusCard, status)
    }
    const announceText = announce && !statusCard
    const closeInternalStatusCard = async (finalStatus: string): Promise<void> => {
      if (statusCard) await this.closeStatusCard(statusCard, finalStatus)
    }
    // 主动重启:孤儿缓冲随轮作废,不兜底推送。必须在 kill 之前丢弃 ——
    // 否则 kill 触发的 exit 处理器会抢先把缓冲当作"进程崩溃残留"兜底推出去,
    // 违背 restart 的作废语义。null this.proc 也放到 kill 之前,让 exit 走
    // stale-proc 早退,不再重复兜底(与 stop() 同一模式)。
    this.bgResumePending = false
    this.sawResultWhileOpening = false
    this.discardOrphanAssistant()
    if (this.proc) {
      report?.(`🛑 停止当前 ${this.backendLabel(this.proc.provider)}`)
      const proc = this.proc
      this.proc = null
      await proc.kill()
    }
    this.stopFooterStatus(this.currentTurn)
    this.currentTurn = null
    this.clearMultiMsgBuffer('restart')
    this.pendingUserMessageCount = 0
    this.pendingMidTurnMsgs = []
    this.pendingTurnInputs = []
    this.lastUserOpenId = ''
    this.releaseAllReactions()
    this.initCount = 0
    this.openingTurn = false
    // bgResumePending / 孤儿缓冲已在 kill 前作废(见上)。
    this.pendingAsks.clear()
    this.pendingHostAsks.clear()
    this.pendingPermissions.clear()
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    if (resume && prevSessionId) {
      this.status = 'starting'
      this.usageTotalsSeedUnknown = true
      report?.(this.withModel(`🔁 恢复上一会话 thread=${prevThreadLabel}…`))
      let proc: AgentProcess
      try {
        proc = this.spawnAgent(prevSessionId)
      } catch (e) {
        const finalStatus = `❌ ${this.backendLabel()} 恢复失败: ${messageOf(e)}`
        log(`session "${this.sessionName}": ${this.selectedProvider} resume failed before spawn: ${messageOf(e)}`)
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        this.proc = null
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      this.proc = proc
      this.wireProc(this.proc)
      const backend = this.backendLabel()
      const initWait = this.selectedProvider === 'claude'
        ? this.waitForProcEarlyFailure(this.proc, CLAUDE_STARTUP_GRACE_MS)
        : this.waitForProcResumeInit(this.proc, () => {
            log(`session "${this.sessionName}": ${this.selectedProvider} resume init still pending after ${RESUME_INIT_NOTICE_MS / 1000}s`)
            report?.(this.withModel(`⏳ 仍在等待 ${backend} init 确认 thread=${prevThreadLabel}…`))
          })
      report?.(this.selectedProvider === 'claude'
        ? `⏳ 检查 ${backend} 恢复启动`
        : `⏳ 等待 ${backend} init 确认`)
      this.proc.sendInitialize()
      const init = await initWait
      if (init.state === 'error' || init.state === 'exit' || init.state === 'timeout') {
        const detail = init.error ? messageOf(init.error) : init.state
        log(`session "${this.sessionName}": ${this.selectedProvider} resume failed: ${detail}`)
        const finalStatus = init.state === 'timeout'
          ? `❌ ${backend} 恢复超时`
          : `❌ ${backend} 恢复失败: ${detail}`
        report?.(finalStatus)
        if (announceText) await feishu.sendText(this.chatId, finalStatus)
        await this.proc?.kill(1000).catch(() => {})
        this.proc = null
        this.status = 'stopped'
        this.opts.onLifecycleChange?.()
        await closeInternalStatusCard(finalStatus)
        return false
      }
      const msg = this.withModel(this.withWorktreeInstructionNotice(
        this.selectedProvider === 'claude' && init.state === 'ready'
          ? `✅ 已准备恢复上一会话 thread=${prevThreadLabel}…`
          : `✅ 已恢复上一会话 thread=${prevThreadLabel}…`,
      ))
      report?.(msg)
      if (announceText) await feishu.sendText(this.chatId, msg)
      this.status = 'idle'
      this.startedAt = Date.now()
      this.opts.onLifecycleChange?.()
      await closeInternalStatusCard(msg)
      return true
    } else {
      // Resume requested but no prior session_id on file — surface it
      // explicitly rather than silently fresh-starting (the old behavior
      // hid the daemon-restart sessionId-loss bug for months).
      if (resume) {
        report?.('⚠️ 没有可恢复的上一会话，将以新会话启动')
        if (announceText) await feishu.sendText(this.chatId, '⚠️ 没有可恢复的上一会话，将以新会话启动')
      }
      // Fresh conversation — drop cumulative stats and the visible turn
      // number so the next card starts from turn 1.
      this.resetFreshConversationState()
      return await this.start({ ...opts, freshConversationStateAlreadyReset: true })
    }
  }

  worktreeProjectName(): string {
    return sessionWorktree.worktreeProjectName(this)
  }

  worktreeProjectDir(): string {
    return sessionWorktree.worktreeProjectDir(this)
  }

  private spawnDeveloperInstructions(): string {
    return sessionWorktree.spawnDeveloperInstructions(this)
  }

  worktreeInstructionLoadedNotice(): string | null {
    return sessionWorktree.worktreeInstructionLoadedNotice(this)
  }

  withWorktreeInstructionNotice(text: string): string {
    return sessionWorktree.withWorktreeInstructionNotice(this, text)
  }

  worktreeExtraInstruction(): string | null {
    return sessionWorktree.worktreeExtraInstruction(this)
  }

  runWorktreeCommand(arg: string, userOpenId: string): Promise<void> {
    return sessionWorktree.runWorktreeCommand(this, arg, userOpenId)
  }

  showWorktrees(): Promise<void> {
    return sessionWorktree.showWorktrees(this)
  }

  showTasklistPanel(): Promise<void> {
    return sessionTasklist.showTasklistPanel(this)
  }

  onTasklistEnable(): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistEnable(this)
  }

  onTasklistDeletePrompt(guidRaw: string): TasklistActionResult {
    return sessionTasklist.onTasklistDeletePrompt(this, guidRaw)
  }

  onTasklistDeleteConfirm(guidRaw: string): Promise<TasklistActionResult> {
    return sessionTasklist.onTasklistDeleteConfirm(this, guidRaw)
  }

  runCompactCommand(): Promise<void> {
    return sessionCompact.runCompactCommand(this)
  }

  showModelPanel(): Promise<void> {
    return sessionModel.showModelPanel(this)
  }

  onModelSelect(modelRaw: string, panelIdRaw = '', userOpenId = '', actionValue: any = null): Promise<ModelActionResult> {
    return sessionModel.onModelSelect(this, modelRaw, panelIdRaw, userOpenId, actionValue)
  }

  onModelEffortSelect(modelRaw: string, effortRaw: string, panelIdRaw = '', userOpenId = '', providerRaw = ''): Promise<ModelActionResult> {
    return sessionModel.onModelEffortSelect(this, modelRaw, effortRaw, panelIdRaw, userOpenId, providerRaw)
  }

  onWorktreeDisband(slugRaw: string): Promise<WorktreeActionResult> {
    return sessionWorktree.onWorktreeDisband(this, slugRaw)
  }

  /** Run a bare-text control command (`hi`, `stop`, `kill`, `restart`, `clear`, `compact`, `model`, `task`)
   * plus their two-letter aliases where applicable.
   * Returns true if the command was consumed (don't forward to Codex). */
  runCommand(raw: string, userOpenId = ''): Promise<boolean> {
    return sessionCommands.runCommand(this, raw, userOpenId)
  }

  /** Build the hi-panel data snapshot for this session.
   *
   * Passing `usage=undefined` paints the `_加载中…_` placeholder — the
   * caller is responsible for the async patch if the panel was sent. */
  async buildConsoleOpts(
    usage: UsageSnapshot | undefined,
    glmUsage?: GlmUsageSnapshot,
  ): Promise<cards.ConsoleOpts> {
    const sysinfo = await readSysInfo()
    return {
      sessionName: this.sessionName,
      status: this.status,
      provider: this.selectedProvider,
      model: this.currentModelLabel() ?? undefined,
      effort: this.currentEffortLabel(),
      worktreeInstructionNotice: this.worktreeInstructionLoadedNotice(),
      peers: [...Session.all]
        .filter(s => s.isRunning())
        .map(s => ({
          ...s.peerSnapshot(),
          isCurrent: s === this,
        })),
      usage,
      glmUsage,
      sysinfo,
    }
  }

  async buildConsoleCard(usage: UsageSnapshot | undefined): Promise<object> {
    return cards.consoleCard(await this.buildConsoleOpts(usage))
  }

  private async patchConsoleUsage(cardId: string): Promise<void> {
    // 按当前 provider 只拉对应后端那一个数据源(方案 C,始终一行):
    //   claude/GLM → src/glm-usage.ts(open.bigmodel.cn / z.ai quota/limit)
    //   codex      → src/usage.ts(codex app-server rate-limit)
    const opts = await this.buildConsoleOpts(undefined)
    if (this.currentProvider() === 'claude') {
      opts.glmUsage = await readGlmUsage()
    } else {
      opts.usage = await readUsage()
    }
    await cardkit.replaceElement(cardId, cards.ELEMENTS.consoleUsage, cards.consoleUsageElement(opts))
  }

  private patchConsoleUsageLater(cardId: string): void {
    void (async () => {
      try {
        await this.patchConsoleUsage(cardId)
      } catch (e) {
        log(`session "${this.sessionName}": consoleUsage patch failed: ${e}`)
      } finally {
        try { await cardkit.dispose(cardId) }
        catch (e) { log(`session "${this.sessionName}": console card dispose failed: ${e}`) }
      }
    })()
  }

  async replaceStatusCardWithConsole(handle: StatusCardHandle, finalStatus: string): Promise<void> {
    handle.timer.stop()
    const elapsed = handle.timer.elapsedSec()
    const consoleOpts = await this.buildConsoleOpts(undefined)
    await cardkit.flush(handle.cardId)
    await cardkit.replaceElement(
      handle.cardId,
      cards.ELEMENTS.footer,
      cards.consoleCurrentModelElement(consoleOpts, cards.ELEMENTS.footer),
    )
    await cardkit.addElement(
      handle.cardId,
      cards.consoleMainElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.footer },
    )
    await cardkit.addElement(
      handle.cardId,
      cards.consoleHostElement(consoleOpts.sysinfo),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleProjects },
    )
    await cardkit.addElement(
      handle.cardId,
      cards.consoleUsageElement(consoleOpts),
      { type: 'insert_after', targetElementId: cards.ELEMENTS.consoleHost },
    )
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      suffix: finalStatus,
    }))
    this.patchConsoleUsageLater(handle.cardId)
  }

  async showConsole(): Promise<void> {
    // Initial paint without usage → cards.ts renders the
    // `_加载中…_` placeholder in the consoleUsage element. We patch
    // it in below once readUsage() resolves; not worth blocking the
    // panel on the Codex account/rate-limit round trip.
    const card = await this.buildConsoleCard(undefined)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) return
    // Patch the usage element asynchronously so the rest of the panel
    // stays responsive. We don't await; failures are logged and the
    // placeholder stays visible (no fallback fabrication).
    void (async () => {
      let cardId = ''
      try {
        cardId = await cardkit.convertMessageToCard(messageId)
        await this.patchConsoleUsage(cardId)
      } catch (e) {
        log(`session "${this.sessionName}": consoleUsage patch failed: ${e}`)
      } finally {
        if (cardId) {
          try { await cardkit.dispose(cardId) }
          catch (e) { log(`session "${this.sessionName}": console card dispose failed: ${e}`) }
        }
      }
    })()
  }

  interrupt(): void {
    if (!this.proc) return
    log(`session "${this.sessionName}": interrupt`)
    this.proc.sendInterrupt()
  }

  private async startColdUserTurn(text: string, wireText: string, userOpenId: string): Promise<void> {
    this.openingTurn = true
    this.resetFreshConversationState()
    this.pendingTurnInputs.push(text)
    try {
      await this.openTurnCard(userOpenId, 'user_message', {
        initialFooter: 'Waiting...(0s)',
        startThinking: false,
        directStart: true,
      })
      const turn = this.currentTurn
      if (!turn) return
      const bootTimer = this.startFooterTimer(
        turn.cardId,
        `🚀 启动 ${this.backendLabel()}`,
        status => this.withModel(status),
      )
      let lastBootStatus = `🚀 启动 ${this.backendLabel()}`
      const ok = await this.start({
        announce: false,
        freshConversationStateAlreadyReset: true,
        onStatus: status => {
          lastBootStatus = status
          bootTimer.setStatus(status)
        },
      })
      bootTimer.stop()
      await cardkit.flush(turn.cardId)
      if (!ok) {
        this.pendingUserMessageCount = 0
        this.pendingMidTurnMsgs = []
        this.pendingTurnInputs = []
        this.lastUserOpenId = ''
        this.releaseAllReactions()
        await this.closeTurnCard(lastBootStatus.startsWith('❌') ? lastBootStatus : '❌ 启动失败', { forcePush: true })
        return
      }
      this.startThinkingFooter(turn)
      this.proc!.sendUserText(wireText, [])
      this.pendingUserMessageCount++
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  // ── Inbound from Feishu ────────────────────────────────────────────
  /** Inbound user message. Starts a Codex turn immediately when idle —
   * the SDK queues internally if a turn is in flight (FIFO, exactly the
   * type-ahead semantics of the native Codex UI). Card opening:
   *   - First msg of session OR no turn in flight  → open card eagerly here
   *   - Mid-flight msg                              → defer; the `init`
   *     handler opens its card when the SDK actually starts the turn
   * This is what lets a single subprocess host both user-typed turns and
   * cron-fired wakeups without the daemon ever calling `sendInterrupt` —
   * `kill`/`stop` are the only paths that interrupt now. */
  async onUserMessage(text: string, files: string[] = [], userOpenId = '', msgId = ''): Promise<void> {
    // Garbage-collect leftover state from a batch the SDK abandoned —
    // most commonly an AskUserQuestion mid-turn, which makes the SDK
    // emit `QUEUE remove × N` and drop every msg we'd already
    // sendText'd into its queue. The daemon doesn't see those remove
    // events, so `pendingUserMessageCount` and `pendingReactionIds`
    // stay stuck. If the SDK is idle right now (no turn, no eager-
    // open in flight) AND init has already fired at least once
    // (otherwise we'd be in the bootstrap race window where
    // leftover count IS valid — see wasBusy comment below), the
    // leftover count is stale and must be cleared BEFORE the
    // wasBusy computation — otherwise this fresh solo message is
    // misclassified as queued and its card closes with `📨 转交新卡`
    // instead of `✅`.
    this.clearStaleIdleQueueState('user_message')
    if (this.startingAgy || this.runningAgy) {
      await feishu.sendText(this.chatId, '⏳ agy 任务正在执行；请等待完成，或发送 stop 打断后再继续。')
      return
    }
    if (
      this.proc?.isAlive() &&
      this.proc.provider !== this.selectedProvider &&
      !this.currentTurn &&
      !this.openingTurn &&
      this.pendingUserMessageCount === 0 &&
      this.pendingMidTurnMsgs.length === 0
    ) {
      await this.stopIdleMismatchedProcess()
    }
    // Capture busy-state SYNC, before any state mutation — this decides
    // whether the message will visibly queue (gets the OneSecond → later
    // CheckMark lifecycle reactions on its Feishu chat message) or
    // eager-open its own card (no reaction needed; the card itself is
    // the acknowledgement).
    //
    // `pendingUserMessageCount > 0` catches the bootstrap race: daemon
    // just spawned, `initCount` is still 0 so no card is open yet, but
    // we've already sendText'd a previous user message into the SDK.
    // The next message lands in the SAME merged-batch SDK queue, so
    // it IS mid-flight from the SDK's perspective — without this
    // check, the daemon would mark it as solo (no ⏳ reaction) and
    // lose track of the queued turn.
    const wasBusy = this.currentTurn !== null || this.openingTurn
      || this.pendingUserMessageCount > 0 || this.pendingMidTurnMsgs.length > 0
    this.lastUserOpenId = userOpenId
    // File hint **inline 在 wireText 内部**,而不是依赖 sendUserText 把
    // files 拼到 message 整体头部。原因:drainMidTurnAndOpen merge N 条
    // wireText 时,若 files 还按整体拼接 → 所有 file hint 全堆在 long
    // message 开头,模型分不清哪个文件配哪条。inline 后每条 sub-message
    // 自带 file hint,SDK side 所有 sendUserText 调用 files 一律传空。
    const filePrefix = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n' : ''
    const wireText = filePrefix + text

    // Reaction helper: track the OneSecond reaction so deleteReaction can
    // clear it later. Use empty-string sentinel until addReaction returns.
    const trackReaction = (id: string) => {
      this.pendingReactionIds.set(id, '')
      void (async () => {
        const rid = await feishu.addReaction(id, 'OneSecond')
        if (!rid) return
        if (this.pendingReactionIds.has(id)) {
          this.pendingReactionIds.set(id, rid)
        } else if (this.currentBatchReactionIds.has(id)) {
          this.currentBatchReactionIds.set(id, rid)
        } else {
          // Orphan: both maps cleared before our add returned. Delete
          // directly so the user doesn't see a stale ⏳ forever.
          void feishu.deleteReaction(id, rid)
        }
      })()
    }

    if (!this.isRunning()) {
      if (this.openingTurn || this.currentTurn) {
        this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
        if (msgId) trackReaction(msgId)
        return
      }
      await this.startColdUserTurn(text, wireText, userOpenId)
      return
    }

    if (this.currentTurn !== null) {
      // Mid-turn — BUFFER instead of immediate sendUserText. The SDK polling
      // loop will not auto-dequeue queued type-ahead msgs after `result`
      // (we explicitly write again to wake the Codex app-server),
      // so writing here would leave the msg stuck until the next user msg
      // arrives. Drain happens in the `result` handler, which both wakes
      // the SDK and opens a fresh card for the new batch turn.
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }

    // No in-flight turn: send straight to SDK. This path handles
    //   - first message after spawn (init not yet fired)
    //   - bootstrap race (sibling msgs landing before init#1)
    //   - solo message after a prior turn has fully closed
    // Eager-open path: open the card BEFORE feeding SDK, so a card-open
    // failure doesn't strand the daemon with SDK processing a turn we
    // have nowhere to render. `!openingTurn` means no sibling is mid-
    // open; `initCount >= 1` means SDK boot init has fired (otherwise
    // the init handler owns turn opening and we just feed the queue
    // below). On failure openTurnCard surfaces a red banner via
    // sendTextRaw; SDK was idle so no interrupt needed.
    if (!this.openingTurn && this.initCount >= 1) {
      this.openingTurn = true
      try {
        // openTurnCard 内部读 pendingTurnInputs 渲染 "📥 收到" panel,要在
        // 它之前 push;之后再 sendUserText 给 SDK,顺序无关紧要(panel 是
        // daemon 自渲染,跟 SDK input 流分离)。
        this.pendingTurnInputs.push(text)
        await this.openTurnCard(userOpenId, 'user_message')
        if (!this.currentTurn) return
        this.proc!.sendUserText(wireText, [])
        this.pendingUserMessageCount++
        this.status = 'working'
      } finally {
        this.openingTurn = false
      }
      return
    }

    // Non-eager path 分两支:
    //   A) openingTurn=true 或 pendingUserMessageCount>0 — sibling 在
    //      openTurnCard,或者 cold-start 第一条 sendUserText 已经发出在
    //      等 SDK init#1。两种情况下直接 sendUserText 都会让 SDK
    //      把这条偷偷合并进 sibling 的 turn(或第一条触发的 cold-start
    //      turn),但 panel input 已经被 snapshot 决定 → "内容跟响应不
    //      一致"race(02:22 + 03:19 现场,以及 commit 2258af4 注释里的
    //      cold-start "first write lands in idle SDK" empirical 行为)。
    //      改成 mid-turn buffer 风格:不 sendUserText、不 push
    //      pendingTurnInputs,等 sibling turn close 后由 result handler
    //      的 midBuffer drain 走 merge 一致处理。
    //   B) cold start 第一条 (initCount===0 且 pendingCount===0) — init
    //      还没来,必须 sendUserText 喂 SDK 才能 wake;init handler 后续
    //      触发 openTurnCard 时一次性消费 pendingTurnInputs。
    if (this.openingTurn || this.pendingUserMessageCount > 0) {
      this.pendingMidTurnMsgs.push({ text, wireText, userOpenId, msgId })
      if (msgId) trackReaction(msgId)
      return
    }
    this.pendingTurnInputs.push(text)
    this.proc!.sendUserText(wireText, [])
    this.pendingUserMessageCount++
    if (wasBusy && msgId) {
      // Bootstrap race / sibling-opening race: until a card is open,
      // the OneSecond ⏳ is the only ack the user gets. The init handler
      // inherits these via currentBatchReactionIds when it opens.
      trackReaction(msgId)
    }
  }

  // ── External API delegated to helpers ──────────────────────────────
  // Thin wrappers so daemon.ts keeps its `session.xxx(...)` call style;
  // bodies live in session-ask.ts / session-permission.ts.

  hasPendingAsk(): boolean {
    return sessionAsk.hasPendingAsk(this)
  }

  hasPendingHostAsk(): boolean {
    return sessionHostAsk.hasPendingHostAsk(this)
  }

  /** 多条消息缓冲入口(`>>>` 开始 / `<<<` 收尾 / 中段普通消息)。返回 true
   *  表示这条已被缓冲或已合并 flush,daemon 不应再调 onUserMessage。*/
  onMultiMessageInbound(text: string, files: string[], userOpenId: string, msgId: string): Promise<boolean> {
    return sessionMultimsg.onMultiMessageInbound(this, text, files, userOpenId, msgId)
  }

  /** 丢弃多条消息缓冲并给每条打 ❌。stop/kill/restart/clear/exit 调用。*/
  clearMultiMsgBuffer(reason: string): void {
    sessionMultimsg.clearMultiMsgBuffer(this, reason)
  }

  onAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionAsk.onAskMessageAnswer(this, text, user, msgId)
  }

  onHostAskMessageAnswer(text: string, user: string, msgId: string): Promise<void> {
    return sessionHostAsk.onHostAskMessageAnswer(this, text, user, msgId)
  }

  onAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<void> {
    return sessionAsk.onAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onHostAskAnswer(toolUseId: string, questionIdx: number, optionIdx: number, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskAnswer(this, toolUseId, questionIdx, optionIdx, user)
  }

  onAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<boolean> {
    return sessionAsk.onAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onHostAskCustomAnswer(toolUseId: string, questionIdx: number, customText: string, user: string): Promise<ModelActionResult> {
    return sessionHostAsk.onHostAskCustomAnswer(this, toolUseId, questionIdx, customText, user)
  }

  onPermissionDecision(requestId: string, decision: 'allow' | 'allow_always' | 'deny', user: string): Promise<void> {
    return sessionPermission.onPermissionDecision(this, requestId, decision, user)
  }

  async startHostAskContinuation(wireText: string): Promise<void> {
    if (!this.isRunning()) throw new Error(`${this.backendLabel()} is not running`)
    if (this.proc?.provider !== 'codex') throw new Error('askusr host continuation is only supported by Codex')
    if (this.currentTurn || this.openingTurn) throw new Error(`${this.backendLabel()} turn still active`)
    this.openingTurn = true
    try {
      await this.openTurnCard('', 'user_message')
      if (!this.currentTurn) throw new Error('failed to open continuation turn card')
      this.proc!.sendUserText(wireText, [])
      this.pendingUserMessageCount++
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  // ── Wiring Codex → Feishu ──────────────────────────────────────────
  private persistResumableSessionId(): void {
    const proc = this.proc
    const sessionId = proc?.sessionId
    if (!proc || !sessionId) return
    feishu.bindSessionResume(this.sessionName, sessionId, proc.provider)
    if (proc.provider !== this.selectedProvider) return
    if (sessionId === this.lastSessionId) return
    this.lastSessionId = sessionId
  }

  // ── 后台游标卡(子 agent / 后台 bash / MCP / workflow 的后台执行) ──────
  // 由 claude-agent-process 的 bg_task_* 事件驱动。卡吸附在对话末尾,被新
  // 消息超越时沉降为历史快照(updateCard),只在全部终态时固化留在原地。
  // 阶段①:建卡 + 节流刷新 + 全终态沉降。游标迁移(onUserMessage 沉降+重建)
  // 是阶段②(待 pendingRebuildBackgroundCard 接入)。

  /** 当前双池快照 —— 喂给纯函数累积器的入参。 */
  private bgStore(): cards.BgStore {
    return { active: this.backgroundTasks, pending: this.pendingBgTasks }
  }

  /** 把 BgStore 双池结果写回 backgroundTasks(active)+ pendingBgTasks。
   *  bg_task_* 事件与子 agent tool_use/tool_result 累积的统一落点。 */
  private applyBgStore(next: cards.BgStore): void {
    this.backgroundTasks = next.active
    this.pendingBgTasks = next.pending
  }

  /** 主线程推进(新的主线程 tool_use / assistant 段定稿):pending 观察池里还没结算
   *  的 task 都没在阻塞主线程 —— 判为后台,提升到 active 入卡。治 run_in_background
   *  的 Bash 不发 is_backgrounded、永远卡 pending 不渲染。 */
  private onMainThreadAdvance(): void {
    if (this.pendingBgTasks.length === 0) return
    this.applyBgStore(cards.promotePendingOnAdvance(this.bgStore()))
    this.onBackgroundTaskChanged()
  }

  /** parentToolUseId 是否归属某个已知后台 task(active 入卡池或 pending 观察池)。
   *  子 agent 前台跑时在 pending,提升后在 active,两池都要认才能持续累积 steps。 */
  private bgTaskOwns(parentToolUseId: string): boolean {
    return this.backgroundTasks.some(t => t.toolUseId === parentToolUseId)
      || this.pendingBgTasks.some(t => t.toolUseId === parentToolUseId)
  }

  private onBackgroundTaskChanged(): void {
    const hasActive = cards.hasActiveBgTask(this.backgroundTasks)
    // 全部终态 → 活卡沉降成历史快照,关 streaming,清句柄
    if (!hasActive) {
      if (this.backgroundCard) void this.settleBackgroundCard()
      return
    }
    // 有活跃任务但无卡(且没在开卡中) → 建活卡。openingBackground 挡住并发事件
    // 在 await sendCard 期间重复开卡(backgroundCard 此时仍 null)。
    if (!this.backgroundCard && !this.openingBackground) {
      this.openingBackground = true
      void this.openBackgroundCard().finally(() => { this.openingBackground = false })
      return
    }
    // 有卡有活跃 → 节流刷新 body
    this.scheduleBackgroundRefresh()
  }

  private async openBackgroundCard(): Promise<void> {
    if (this.backgroundCard) return
    const card = cards.backgroundLiveCard(this.backgroundTasks)
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": background card send failed`)
      return
    }
    let cardId: string
    try {
      cardId = await cardkit.convertMessageToCard(messageId)
    } catch (e) {
      log(`session "${this.sessionName}": background card id_convert failed: ${e}`)
      return
    }
    // 初始 body = 每任务一个 panel(无概要区)。
    cardkit.recordCardCreated(cardId, this.backgroundTasks.length)
    this.backgroundCard = { messageId, cardId }
    this.backgroundDetailAdded = new Set(this.backgroundTasks.map(t => t.id))
    log(`session "${this.sessionName}": background card opened cardId=${cardId.slice(0, 12)} tasks=${this.backgroundTasks.length}`)
    this.startBackgroundRefreshTick()
  }

  /** 周期 tick:无 task_progress 事件的 shell 后台任务(如 codex exec)靠它刷新 header
   *  运行时长。事件触发的节流刷新(scheduleBackgroundRefresh)负责详情 diff,tick 只补时长。 */
  private startBackgroundRefreshTick(): void {
    if (this.backgroundRefreshTick) return
    this.backgroundRefreshTick = setInterval(() => {
      if (!this.backgroundCard) return
      if (!cards.hasActiveBgTask(this.backgroundTasks)) return
      this.refreshBackgroundCardFull()
    }, BACKGROUND_REFRESH_TICK_MS)
  }

  private stopBackgroundRefreshTick(): void {
    if (this.backgroundRefreshTick) {
      clearInterval(this.backgroundRefreshTick)
      this.backgroundRefreshTick = null
    }
  }

  /** 节流刷新:合并 1.5s 窗口内的 task_progress 风暴,避免打爆 cardkit。
   *  事件触发的刷新走 full(summary + detail diff);5s tick 只刷 summary。 */
  private scheduleBackgroundRefresh(): void {
    if (!this.backgroundCard) return
    if (this.backgroundRefreshTimer) return
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null
      this.refreshBackgroundCardFull()
    }, 1500)
  }

  /** 全量刷新:增量同步每任务的 panel。新任务 addElement panel;已有任务
   *  replaceElement 整个 panel(header 状态/时长 + body 一起)。 */
  private refreshBackgroundCardFull(): void {
    const handle = this.backgroundCard
    if (!handle) return
    const now = Date.now()
    for (const t of this.backgroundTasks) {
      if (!this.backgroundDetailAdded.has(t.id)) {
        this.backgroundDetailAdded.add(t.id)
        void cardkit.addElement(handle.cardId, cards.backgroundTaskPanel(t, now))
      } else {
        void cardkit.replaceElement(handle.cardId, cards.BG_ELEMENTS.panel(t.id), cards.backgroundTaskPanel(t, now))
      }
    }
  }

  /** 全部后台任务终态:活卡 updateCard 成历史快照(只终态墓碑),关 streaming,
   *  dispose,清句柄。卡留在原地不再跟随。 */
  private async settleBackgroundCard(): Promise<void> {
    const handle = this.backgroundCard
    if (!handle) return
    // 同步清空句柄 —— 防止并发 bg_task_settled(多任务同毫秒结算)触发两次 settle
    // 都读到非 null 的 race。后续 await 期间再来的 settle 看到 null 直接 return。
    this.backgroundCard = null
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer)
      this.backgroundRefreshTimer = null
    }
    this.stopBackgroundRefreshTick()
    await cardkit.flush(handle.cardId)
    await feishu.updateCard(handle.messageId, cards.backgroundHistoryCard(this.backgroundTasks))
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({ suffix: '🧭 后台任务已结束' }))
    await cardkit.dispose(handle.cardId)
    // 全部终态 → 清空 active 跟踪(已固化在历史卡);下次新后台 task 从空数组起步。
    // pending 观察池不动:前台 task 可能仍在跑,它们结算时自己从 pending 丢。
    this.backgroundTasks = []
    this.backgroundDetailAdded.clear()
    log(`session "${this.sessionName}": background card settled cardId=${handle.cardId.slice(0, 12)}`)
  }

  /** 游标迁移:发新主卡前调用。旧后台卡沉降 —— 有终态任务则成历史墓碑
   *  (backgroundHistoryCard),全活跃无终态则留固定标识(backgroundMigratedMarker)。
   *  终态任务从 backgroundTasks 移除(已固化在旧卡),活跃任务保留待新卡重建。 */
  private async migrateBackgroundCard(): Promise<void> {
    const handle = this.backgroundCard
    if (!handle) return
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer)
      this.backgroundRefreshTimer = null
    }
    this.stopBackgroundRefreshTick()
    const terminalCount = this.backgroundTasks.filter(cards.isBgTerminal).length
    await cardkit.flush(handle.cardId)
    if (terminalCount > 0) {
      // 有终态:旧卡成历史快照(backgroundHistoryCard 内部只渲染终态)。
      await feishu.updateCard(handle.messageId, cards.backgroundHistoryCard(this.backgroundTasks))
    } else {
      // 全活跃无终态:留固定标识。
      await feishu.updateCard(handle.messageId, cards.backgroundMigratedMarker())
    }
    cardkit.cancelSummary(handle.cardId)
    await cardkit.patchSettings(handle.cardId, cards.streamingOffSettings({ suffix: '🧭 已迁移至新卡' }))
    await cardkit.dispose(handle.cardId)
    this.backgroundCard = null
    // 终态任务已固化在旧卡历史,从活跃跟踪移除;活跃任务保留(新卡重建时显示)。
    this.backgroundTasks = this.backgroundTasks.filter(t => !cards.isBgTerminal(t))
    this.backgroundDetailAdded.clear()
    log(`session "${this.sessionName}": background card migrated cardId=${handle.cardId.slice(0, 12)} terminal=${terminalCount} active=${this.backgroundTasks.length}`)
  }

  private wireProc(p: AgentProcess): void {
    p.on('error', err => {
      log(`session "${this.sessionName}": ${p.provider} process error: ${err}`)
    })
    p.on('init', () => {
      this.persistResumableSessionId()
      this.initCount++
      log(`session "${this.sessionName}": SDK init#${this.initCount} pendingCount=${this.pendingUserMessageCount} midBuffer=${this.pendingMidTurnMsgs.length} currentTurn=${this.currentTurn ? 'yes' : 'no'} openingTurn=${this.openingTurn}`)

      // Boot init (initCount === 1) is claimed by `onUserMessage`'s
      // eager-open path — if a user message landed before the init
      // arrived, it sits in `pendingUserMessageCount` and we drain it
      // below; otherwise the init opens nothing. Subsequent inits
      // (initCount >= 2) can mark the start of an SDK-initiated turn
      // when the SDK is draining the type-ahead queue we fed it via
      // `sendUserText` (isUserBatch).
      //
      // SDK-driven rotation puts the boundary HERE: the previous
      // turn's `result` already closed the in-flight card with
      // `📨 转交新卡` (because pendingUserMessageCount > 0). Now we
      // open a fresh card whose top panel shows the queued messages.
      // currentTurn should be null at this point (result null'd it);
      // the openingTurn guard catches the eager-open vs init race.
      if (this.currentTurn || this.openingTurn) return
      const isUserBatch = this.pendingUserMessageCount > 0
      // SDK 自发恢复轮:后台任务结算通知唤醒 SDK 合并结果,init 没有伴随
      // 用户消息。必须照样开卡,否则这一轮的全部正文会被 appendAssistant
      // 静默丢弃(2026-07-04 etmmo 终报告事故)。bgResumePending 只在
      // bg_task_settled 落在无活跃 turn 时置位,保证 probe/模型切换等
      // 无关的空 init 不受影响。
      const isBgResume = !isUserBatch && this.bgResumePending
      if (!isUserBatch && !isBgResume) return
      this.bgResumePending = false
      const userOpenId = this.lastUserOpenId
      if (isUserBatch) {
        this.pendingUserMessageCount = 0
        // Inherit the queued reaction_ids — this turn is collectively
        // responsible for releasing their OneSecond reactions when it
        // closes (via deleteReaction in closeTurnCard).
        this.currentBatchReactionIds = this.pendingReactionIds
        this.pendingReactionIds = new Map()
      }
      this.openingTurn = true
      this.sawResultWhileOpening = false // 本次开卡的竞态标记,落地时判定
      void (async () => {
        try {
          await this.openTurnCard(userOpenId, isUserBatch ? 'user_message' : 'bg_task_resume')
          if (!this.currentTurn) {
            if (isUserBatch) {
              // SDK already started this turn (its `init` is what got us
              // here) but we have no card to render into. Interrupt so
              // assistant/tool events aren't silently dropped while the
              // model burns tokens. Release the reactions this batch
              // inherited (init handler moved them above) — otherwise
              // they stay ⏳ forever on the user's chat messages.
              log(`session "${this.sessionName}": init-path openTurnCard failed — sendInterrupt + release reactions`)
              this.proc?.sendInterrupt()
              this.releaseAllReactions()
            } else {
              // 恢复轮开卡失败不打断 —— 打断会把正在合并的后台结果整轮
              // 作废。cardless 续窗:此后正文继续进孤儿缓冲。若 result 已在
              // 开卡窗口内到达(不会再有第二次),这里立即兜底,否则由
              // result 处理器 flush。
              this.bgResumeCardless = true
              if (this.sawResultWhileOpening) {
                this.sawResultWhileOpening = false
                log(`session "${this.sessionName}": bg-resume openTurnCard failed, result already arrived — flushing orphan now`)
                this.flushOrphanAssistantToChat('bg-resume open failed, result already arrived')
              } else {
                log(`session "${this.sessionName}": bg-resume openTurnCard failed — orphan text flush will cover the output`)
              }
            }
          } else if (this.sawResultWhileOpening) {
            // 卡片开成了,但这一轮的 result 已在开卡 await 窗口内到达 ——
            // result 处理器当时 currentTurn 还是 null,closeTurnCard 空转了。
            // 这里补一次收尾,否则卡片 footer 永远计时、session 卡在 working。
            this.sawResultWhileOpening = false
            log(`session "${this.sessionName}": result raced card-open — closing freshly-opened turn card now`)
            await this.closeTurnCard(undefined, { hasFreshResult: true })
            this.status = 'idle'
          } else {
            this.status = 'working'
          }
        } finally {
          this.openingTurn = false
        }
      })()
    })
    p.on('turn_started', () => {
      this.persistResumableSessionId()
      const total = this.proc?.lastTotalUsage
      if (this.usageTotalsSeedUnknown && !total) {
        this.currentTurnUsageBaseline = null
        this.currentTurnUsageBaselineKnown = false
        return
      }
      this.currentTurnUsageBaseline = total ? { ...total } : null
      this.currentTurnUsageBaselineKnown = true
    })
    p.on('token_usage', ({ totalUsage }: TokenUsageUpdated) => {
      this.persistResumableSessionId()
      if (totalUsage) this.usageTotalsSeedUnknown = false
    })
    p.on('turn_plan_updated', (plan: TurnPlanUpdated) => {
      this.handleTurnPlanUpdated(plan)
    })
    p.on('plan_delta', (delta: PlanDelta) => {
      this.handlePlanDelta(delta)
    })
    p.on('context_compacted', (notice: ContextCompactedNotification) => {
      this.handleContextCompacted(notice)
    })
    p.on('rate_limits_updated', (rateLimits: any) => {
      // usage.ts 的缓存是 codex 专属(planType/primary/secondary 形状)。claude
      // 的 rate_limit_info 形状不同但同样 truthy,写入会把 codex 快照覆盖成
      // 全 null 的假 ok 数据 —— 只放行 codex 进程的事件。
      if (p.provider === 'codex') updateUsageFromRateLimits(rateLimits)
    })
    p.on('thread_goal_updated', (goal: ThreadGoal) => {
      this.handleThreadGoalUpdated(goal)
    })
    p.on('thread_goal_cleared', () => {
      this.handleThreadGoalCleared()
    })
    p.on('assistant_text', ({ text }: { text: string }) => {
      this.appendAssistant(text)
    })
    p.on('assistant_block_stop', () => {
      // 一段 content block 收尾(SSE content_block_stop)→ 把当前 assistant 段
      // 静态化成完整 markdown,然后 reset 段游标让下一段开新元素。这条 emit 在该段最后一个
      // text_delta 之后同步到达(codex-process 按 stdout 行序 emit),所以
      // appendAssistant 已把全量累进 currentAssistantText,这里定稿拿到的是完整段。
      this.finalizeCurrentAssistantSegment()
      // 主线程定稿一段 assistant = 主 agent 在继续说话、没在等 pending task → 提升后台入卡。
      this.onMainThreadAdvance()
    })
    p.on('tool_use', ({ id, name, input, parentToolUseId }: { id: string; name: string; input: any; parentToolUseId: string | null }) => {
      sessionTools.addTool(this, id, name, input)
      // 主线程发起新 tool_use = 主 agent 没在等 pending 里的 task → 它们是后台,提升入卡。
      // 前台 task 的 settled 先于主线程下一个 tool_use 到达,pending 已空,不会误提。
      if (!parentToolUseId) this.onMainThreadAdvance()
      // 主线程 Task tool_use(触发子 agent):记 id 供 task_started 缺 tool_use_id 时兜底关联
      if (!parentToolUseId && (name === 'Task' || name === 'Agent')) this.lastMainTaskToolUseId = id
      // 子 agent 内的工具调用(parentToolUseId 非空)额外累积进对应后台 task 的 steps[]。
      // 同时覆盖 active 和 pending:前台子 agent 跑时 steps 暂存 pending,
      // is_backgrounded 提升后自带 steps 带到 active。
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolUse(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, id, name, input,
        ))
        this.onBackgroundTaskChanged()
      }
    })
    p.on('tool_result', ({ tool_use_id, content, is_error, parentToolUseId }: any) => {
      sessionTools.completeTool(this, tool_use_id, content, is_error)
      if (parentToolUseId && this.bgTaskOwns(parentToolUseId)) {
        this.applyBgStore(cards.applyBgToolResult(
          { active: this.backgroundTasks, pending: this.pendingBgTasks },
          parentToolUseId, tool_use_id, content, is_error,
        ))
        this.onBackgroundTaskChanged()
      }
    })
    p.on('can_use_tool', (req: CanUseToolRequest) => {
      sessionPermission.renderPermission(this, req)
    })
    p.on('hook_callback', (req: HookCallbackRequest) => {
      // No hooks registered → fail-safe ack.
      this.proc?.sendHookResponse(req.request_id, {})
    })
    p.on('result', () => {
      this.persistResumableSessionId()
      this.accumulateResultStats()
      // result 抢在 openTurnCard 的 await 窗口内到达:标记给开卡 IIFE,
      // 它落地后据此立即收尾(否则卡片悬挂、session 卡在 working)。
      if (this.openingTurn) this.sawResultWhileOpening = true
      // User just hit `stop` — this result is the SDK closing the in-flight
      // turn after sendInterrupt landed. The card already shows `🛑 打断`
      // from the stop path, so skip the rest unconditionally. 被取消轮次的
      // post-interrupt 尾巴随之作废,不兜底推送。
      if (this.userInterrupted) {
        this.userInterrupted = false
        this.discardOrphanAssistant()
        this.bgResumePending = false
        const subtype = this.proc?.lastResult.subtype ?? 'unknown'
        const isError = this.proc?.lastResult.is_error === true
        log(`session "${this.sessionName}": SDK result after user stop subtype=${subtype} isError=${isError} — ignored`)
        this.status = 'idle'
        return
      }
      // 整轮无卡且不在开卡中(恢复轮开卡失败):孤儿正文纯文本兜底。开卡
      // 窗口内(openingTurn)不 flush —— 让 openTurnCard 把缓冲并入卡片,
      // 避免又推一遍。有卡的轮次已在开卡时并入,这里 flush 为 no-op。
      if (!this.currentTurn && !this.openingTurn) this.flushOrphanAssistantToChat('result with no turn card')
      const hasMidTurn = this.pendingMidTurnMsgs.length > 0
      const isError = this.proc?.lastResult.is_error === true
      const subtype = this.proc?.lastResult.subtype ?? 'success'
      const hostAskFlowActive = this.pendingHostAsks.size > 0

      let suffix: string | undefined
      let forcePush = false

      const backend = this.proc ? this.backendLabel(this.proc.provider) : this.backendLabel()
      if (hasMidTurn && !hostAskFlowActive) {
        suffix = isError ? `⚠️ ${backend} ${subtype},用户已介入` : '📨 转交新卡'
      } else if (isError) {
        suffix = `⚠️ ${backend} ${subtype}`
        forcePush = true
      }

      log(`session "${this.sessionName}": SDK result subtype=${subtype} isError=${isError} midBuffer=${this.pendingMidTurnMsgs.length} forcePush=${forcePush}`)
      void this.closeTurnCard(suffix, { forcePush, hasFreshResult: true })
      this.status = 'idle'
      sessionHostAsk.resumeAnsweredHostAsks(this)

      if (hasMidTurn && !hostAskFlowActive) {
        void this.drainMidTurnAndOpen()
      }
    })
    p.on('bg_task_started', (e: BgTaskStartedEvent) => {
      // SDK 若没填 tool_use_id,用最近的主线程 Task tool_use id 兜底 —— 子 agent 消息
      //  的 parent_tool_use_id 等于它,据此才能把 steps 关联到 task。
      const toolUseId = e.tool_use_id ?? this.lastMainTaskToolUseId ?? undefined
      log(`session "${this.sessionName}": bg_task_started task=${e.task_id} type=${e.task_type ?? '-'} subagent=${e.subagent_type ?? '-'} toolUseId=${toolUseId?.slice(0, 8) ?? '-'} desc=${(e.description ?? '').slice(0, 40)}`)
      this.applyBgStore(cards.applyBgTaskStarted(this.bgStore(), { ...e, tool_use_id: toolUseId }))
      this.onBackgroundTaskChanged()
    })
    p.on('bg_task_progress', (e: BgTaskProgressEvent) => {
      this.applyBgStore(cards.applyBgTaskProgress(this.bgStore(), e))
      this.onBackgroundTaskChanged()
    })
    p.on('bg_task_updated', (e: BgTaskUpdatedEvent) => {
      this.applyBgStore(cards.applyBgTaskUpdated(this.bgStore(), e))
      this.onBackgroundTaskChanged()
    })
    p.on('bg_task_settled', (e: BgTaskSettledEvent) => {
      log(`session "${this.sessionName}": bg_task_settled task=${e.task_id} status=${e.status}`)
      this.applyBgStore(cards.applyBgTaskSettled(this.bgStore(), e))
      this.onBackgroundTaskChanged()
      // turn 已收尾后才结算的任务:SDK 会自发开一轮恢复轮合并结果,
      // 标记给下一个无用户批次的 init 开卡。
      if (!this.currentTurn && !this.openingTurn && this.initCount >= 1) {
        this.bgResumePending = true
      }
    })
    p.on('exit', ({ code, signal, expected }: any) => {
      log(`session "${this.sessionName}": ${p.provider} exited code=${code} signal=${signal} expected=${expected}`)
      if (this.proc !== p) {
        log(`session "${this.sessionName}": ignore stale ${p.provider} exit; current=${this.proc?.provider ?? 'none'}`)
        return
      }
      this.proc = null
      // 进程死了,残留的孤儿正文再不兜底就永远丢了(非用户主动停止的崩溃
      // 路径;stop/restart 已在 kill 前 null 掉 this.proc,走上面的 stale
      // 早退不到这里)。
      this.flushOrphanAssistantToChat('process exit')
      this.bgResumePending = false
      this.bgResumeCardless = false
      this.sawResultWhileOpening = false
      this.stopFooterStatus(this.currentTurn)
      this.currentTurn = null
      this.clearMultiMsgBuffer('process exit')
      this.pendingUserMessageCount = 0
      this.pendingMidTurnMsgs = []
      this.pendingTurnInputs = []
      this.lastUserOpenId = ''
      this.releaseAllReactions()
      this.initCount = 0
      this.openingTurn = false
      // 进程没了 ⇒ 任何 pending ask 都不可能再收到 can_use_tool 或回传答案,
      // 定义上已死。不清的话 hasPendingAsk() 恒 true,后续每条消息都被
      // onAskMessageAnswer 当僵尸答案吞掉,session 焊死到下次 daemon 重启
      // (kill/restart 同样在上面补了这一清理)。
      this.pendingAsks.clear()
      this.pendingHostAsks.clear()
      this.pendingPermissions.clear()
      this.userInterrupted = false
      this.currentTurnUsageBaseline = null
      this.currentTurnUsageBaselineKnown = false
      this.usageTotalsSeedUnknown = false
      this.status = 'stopped'
      this.opts.onLifecycleChange?.()
      if (!expected && code !== 0 && signal !== 'SIGTERM') {
        void feishu.sendText(this.chatId, `⚠️ ${this.backendLabel(p.provider)} 异常退出 (code=${code}, signal=${signal})。回复任意消息将重新启动。`)
      }
    })
  }

  /** Pull per-turn numbers off `proc.lastResult` (set by CodexProcess when
   * the `result` message landed) and roll them into cumStats + the
   * "上一轮" delta. Turn usage uses absolute thread totals from
   * `thread/tokenUsage/updated.total` minus the baseline captured at
   * `turn_started`, so a multi-request turn is aggregated correctly
   * instead of inheriting only the final request's `last` snapshot.
   * Called exactly once per result event, right before closeTurnCard. */
  private accumulateResultStats(): void {
    const r = this.proc?.lastResult
    if (!r) return
    // Claude result.usage is scoped to the just-finished SDK query; after a
    // resumed session starts with no local total baseline, this is the only
    // accurate per-turn figure we have.
    const u = this.currentTurnUsageBaselineKnown
      ? diffUsageTotals(this.proc?.lastTotalUsage, this.currentTurnUsageBaseline)
      : this.proc?.provider === 'claude' && r.usage
        ? { ...r.usage }
        : null
    this.lastTurnUsage = u
    this.currentTurnUsageBaseline = null
    this.currentTurnUsageBaselineKnown = false
    // 有效 token = 真正喂进(input + 本轮新建缓存)+ 产出。故意不含
    // cache_read_input_tokens —— 那是把整段已缓存上下文又复读一遍的计费量,
    // 每轮几乎等于全窗口,计进来会让累计虚高一个量级。这里的 usage 是
    // 整个 turn 的绝对总量差值,不是最后一次模型请求的快照。
    const tokens = effectiveTurnTokens(u)
    // Claude subscription/router cost fields are not reliable enough to show
    // as billing. Keep Claude turns token-only even if the SDK sends dollars.
    const costUsd = this.proc?.provider === 'claude' ? 0 : r.cost_delta_usd ?? 0
    const durationMs = r.duration_ms ?? 0
    if (tokens != null) this.cumStats.tokens += tokens
    this.cumStats.costUsd += costUsd
    this.cumStats.turns += r.num_turns ?? 1
    this.lastTurnDelta = { tokens, costUsd, durationMs }
  }

  /** Current context-window occupancy. Claude 路径直接读 SDK modelUsage 算好
   * 的输入侧占用(proc.lastContextTokens = input+cache_read+cache_creation,
   * 不含 output);Codex 路径继续用 lastUsage.total_tokens。 */
  private currentContextTokens(): number | null {
    if (this.proc?.provider === 'claude') {
      return this.proc?.lastContextTokens ?? null
    }
    const u = this.proc?.lastUsage as CodexUsage | null | undefined
    return contextTokensFromUsage(u)
  }

  /** Display denominator for context percentage. Codex: app-server's
   * effective modelContextWindow;Claude: SDK modelUsage.contextWindow。 */
  private contextLimitForDisplay(): number | null {
    return contextLimitFromAppServer(this.proc?.lastContextWindow)
  }

  /** Drain `pendingMidTurnMsgs` to the SDK and open a fresh card for the
   * resulting batch turn. Called from the `result` handler when buffered
   * mid-turn messages need to start their own turn. The `sendUserText`
   * calls wake the SDK polling loop (priority="now" semantics) and
   * comprise the input for the new turn. Opens the card here rather
   * than deferring to init because the init for this batch will arrive
   * with `currentTurn` already set and bail.
   *
   * N 条 wireText 用 `\n\n` join 成 **单条** sendUserText 发给 SDK,而不是
   * N 次独立写。背景:SDK polling loop 在 turn 边界一次只 dequeue 一条
   * user message 进 prompt,N 次独立写会让
   * SDK 把第 1 条单独开 turn、剩 N-1 条进下一 turn —— daemon 这边 panel
   * 在 openTurnCard 时已经 commit 了全部 N 条到 "前一个" turn,跟 SDK
   * 实际 turn 边界错位(03:19 现场 turn=5 panel 7 条 vs 模型只看到 1 条
   * "1 和 2 两条都收到了")。join 成单条后,SDK 看到 1 个 user message,
   * panel 跟模型实际 input 一致。
   *
   * pendingCount 一次 ++(对应一次 sendUserText)。因为 SDK 不再拆 turn,
   * commit 2258af4 当年用累加保护 spurious 第二 turn 的逻辑不再需要 —
   * SDK 不会自发开 user_batch 子 turn。 */
  private async drainMidTurnAndOpen(): Promise<void> {
    if (this.pendingMidTurnMsgs.length === 0) return
    const batch = this.pendingMidTurnMsgs
    this.pendingMidTurnMsgs = []
    this.openingTurn = true
    try {
      // daemon-side state: panel inputs + reaction transfer。不走 sendUserText,
      // SDK 那边由 join 后的单条统一处理。
      for (const msg of batch) {
        this.pendingTurnInputs.push(msg.text)
        if (msg.msgId) {
          const rid = this.pendingReactionIds.get(msg.msgId) ?? ''
          this.currentBatchReactionIds.set(msg.msgId, rid)
          this.pendingReactionIds.delete(msg.msgId)
        }
      }
      // wireText 每条已经在 onUserMessage 内 inline 了自己的 file hint;
      // SDK side files 一律传空,避免 file ↔ message 归属丢失(P1-1)。
      const merged = batch.map(m => m.wireText).join('\n\n')
      this.proc!.sendUserText(merged, [])
      this.pendingUserMessageCount++
      const last = batch[batch.length - 1]
      const userOpenId = last?.userOpenId ?? this.lastUserOpenId
      await this.openTurnCard(userOpenId, 'user_message')
      // 不动 pendingUserMessageCount;init handler 在 isUserBatch 路径
      // 自己 reset。merge 之后 SDK 不拆 turn,不会再有空 user_message turn。
      this.status = 'working'
    } finally {
      this.openingTurn = false
    }
  }

  private async openTurnCard(
    userOpenId: string,
    trigger: TurnState['trigger'],
    opts: { initialFooter?: string; startThinking?: boolean; directStart?: boolean } = {},
  ): Promise<void> {
    // 任何 turn 开卡都消费掉 pending 的恢复轮标记 —— 若用户消息抢在恢复轮
    // init 前开了卡,SDK 会把结算通知并入该轮,标记留着只会误伤后续空 init。
    this.bgResumePending = false
    // ── 后台游标卡迁移 ── 发新主卡前,先把旧后台卡沉降(终态墓碑/固定标识),
    // 主卡落地后(currentTurn 赋值处)重建后台卡重回末尾。迁移失败不阻塞主卡。
    if (this.backgroundCard && cards.hasActiveBgTask(this.backgroundTasks)) {
      try {
        await this.migrateBackgroundCard()
        this.pendingRebuildBackgroundCard = true
      } catch (e) {
        log(`session "${this.sessionName}": background migrate failed (non-blocking): ${e}`)
      }
    }
    const turn = ++this.turnCounter
    // Snapshot+clear pendingTurnInputs synchronously here so concurrent
    // pushes between snapshot and the await don't sneak into THIS turn's
    // panel (they'll be picked up by the next turn's open).
    const userInputs = this.pendingTurnInputs
    this.pendingTurnInputs = []
    log(`session "${this.sessionName}": openTurnCard turn=${turn} trigger=${trigger} inputs=${userInputs.length}`)
    const initialFooter = this.withModel(opts.initialFooter ?? 'Waiting...(0s)')
    const card = cards.mainConversationCard({
      sessionName: this.sessionName,
      turn,
      provider: this.proc?.provider ?? this.selectedProvider,
      model: this.currentModelLabel() ?? undefined,
      effort: this.currentEffortLabel(),
      kind: trigger,
      userInputs,
      initialFooter,
      directStart: opts.directStart,
    })
    const messageId = await feishu.sendCard(this.chatId, card)
    if (!messageId) {
      log(`session "${this.sessionName}": openTurnCard sendCard EXHAUSTED retries — surfacing via raw text`)
      // sendCard already retried 3× through the SDK. If it still came back
      // null we're either on a sustained SDK-axios outage or a Feishu
      // business reject. Either way the user just sent us a message and
      // it's gone into a black hole — surface that explicitly so they
      // know to resend instead of waiting for a reply that won't come.
      // Use raw fetch (not sendText) because if the SDK is the broken
      // thing we'd be doomed to silence otherwise.
      // bg-resume 轮没有"用户这条消息",提示重发只会误导;其输出会走
      // 孤儿缓冲纯文本兜底,这里不必告警。
      if (trigger === 'user_message') {
        await feishu.sendTextRaw(
          this.chatId,
          '❌ 创建对话卡片失败 (Feishu SDK 重试 3 次后仍连不上)。你这条消息没能送到 Codex,请稍后重发。',
        )
      }
      // currentTurn left null as the failure signal. Caller decides
      // whether to sendInterrupt: onUserMessage's eager-open path
      // hasn't fed SDK yet so doesn't need to; the init handler has
      // (SDK started the turn itself) and must.
      return
    }
    let cardId: string
    try { cardId = await cardkit.convertMessageToCard(messageId) }
    catch (e) { log(`session "${this.sessionName}": id_convert failed: ${e}`); return }
    // Tell cardkit how many elements the initial body already has so
    // its element-count tracker is correct from the first addElement
    // onwards (bg-resume banner + userInputPanel + footer).
    const initialElementCount =
      (trigger === 'bg_task_resume' ? 1 : 0) +
      (userInputs.length > 0 ? 1 : 0) +
      1
    cardkit.recordCardCreated(cardId, initialElementCount, (code) => this.onCardWriteFailure(code))
    const turnState: TurnState = {
      cardId,
      messageId,
      userOpenId,
      trigger,
      toolCount: 0,
      toolByUseId: new Map(),
      planSteps: [],
      planExplanation: null,
      planUpdateCount: 0,
      goalUpdateCount: 0,
      contextCompactCount: 0,
      contextCompactionPending: new Map(),
      readBatches: new Map(),
      openReadBatchI: null,
      taskCreateI: null,
      taskUpdateI: null,
      taskBoardResetThisTurn: false,
      taskLiveInserted: false,
      assistantSegmentCount: 0,
      currentAssistantSegmentId: null,
      currentAssistantText: '',
      segmentTexts: new Map(),
      startedAt: Date.now(),
      footerStatusHandle: null,
      footerStatusStartedAt: 0,
      footerStatusLabel: null,
      rotating: null,
      rotateCount: 0,
      failureRotateCount: 0,
      rotateGivenUp: false,
      outboundSeenPaths: new Set(),
      outboundSentPaths: new Set(),
      hostAskMarkersSeen: new Set(),
    }
    this.currentTurn = turnState
    if (opts.startThinking !== false) this.startThinkingFooter(turnState)
    // 开卡 await 窗口期(sendCard/id_convert)先到的 assistant 正文攒在
    // 孤儿缓冲里,现在有卡了,作为首段并入 —— 后续 delta 接着正常追加。
    const orphan = this.takeOrphanAssistantText()
    if (orphan) {
      this.appendAssistant(orphan)
      this.finalizeCurrentAssistantSegment()
    }
    // 主卡落地 → 若刚迁移过旧后台卡且仍有活跃任务,重建后台卡重回末尾。
    if (this.pendingRebuildBackgroundCard) {
      this.pendingRebuildBackgroundCard = false
      if (cards.hasActiveBgTask(this.backgroundTasks)) void this.openBackgroundCard()
    }
  }

  /** Cheap synchronous check called from stream handlers right before
   * they `addElement` a new tool / assistant segment / Read batch /
   * etc. If the current card is close to Feishu's element ceiling and
   * we haven't already kicked off a rotation, fire-and-forget start a
   * `startMidTurnRotate` and let it run async on its own. The current
   * stream handler still uses `turn.cardId` (the old card) for this
   * iteration — that's fine because (a) cardkit's per-card queue keeps
   * its writes ordered against the soft-close that's about to happen,
   * and (b) the soft limit (CARD_ELEMENT_SOFT_LIMIT=50) sits well under
   * the observed ~75 ceiling, so an in-flight add either fits or — if it
   * doesn't — trips onCardWriteFailure, which rotates reactively anyway. */
  maybeMidTurnRotate(): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (cardkit.getElementCount(turn.cardId) < CARD_ELEMENT_SOFT_LIMIT) return
    this.startMidTurnRotate(turn)
  }

  /** Reactive rotation trigger: cardkit calls this (via the addElement
   * onFailure path) whenever a write to the card was rejected by Feishu —
   * ANY code, not just 300305/300315. The element limit was the symptom
   * that surfaced this, but the same response ("the card is unwritable,
   * move to a fresh one") applies to a schema/rule change, or a transient
   * server reject that survived the reopen-retry. Deliberately does NOT
   * consult getElementCount: a failed add never bumps the counter, so the
   * count is stuck below the soft cap exactly when a rotate is most needed
   * (the bug that froze the 2026-05-23 turn at ~76 elements). Idempotent
   * (a rotation already in flight is left alone) and capped
   * (MAX_MIDTURN_ROTATES) so a persistent failure can't spin forever. */
  onCardWriteFailure(code?: number): void {
    const turn = this.currentTurn
    if (!turn) return
    if (turn.rotating) return
    if (turn.rotateGivenUp) return
    if (turn.failureRotateCount >= MAX_MIDTURN_ROTATES) {
      turn.rotateGivenUp = true
      // log-only 要名副其实:停掉每秒 footer 计时器,并把当前卡整卡标记
      // 拒写,否则 ticker + stream handler 会对着死卡刷到 turn 结束
      // (2026-07-04:11 分钟 663 条 300308)。
      this.stopFooterStatus(turn)
      cardkit.markCardWriteDead(turn.cardId)
      log(`session "${this.sessionName}": failure-rotate cap (${MAX_MIDTURN_ROTATES}) hit — giving up, rest of turn is log-only`)
      void feishu.sendTextRaw(this.chatId, `⚠️ 卡片写入失败已触发 ${MAX_MIDTURN_ROTATES} 次换卡仍未恢复(疑似飞书故障或元素超限),本轮后续输出仅日志可见。`)
      return
    }
    const why = cardkit.isElementLimitCode(code) ? `element limit (${code})` : `write failure (code=${code ?? 'n/a'})`
    log(`session "${this.sessionName}": ${why} on card=${turn.cardId.slice(0, 8)}… — rotating to fresh card`)
    turn.failureRotateCount++
    this.startMidTurnRotate(turn)
  }

  /** Open a fresh card under the **same** SDK turn number to dodge
   * Feishu's per-card element limit. The old card stays in the chat —
   * we flip its footer to "📨 已续至下一张卡", turn streaming off, and
   * dispose its cardkit state — but it never becomes the writable one
   * again. Turn state is reset so subsequent stream handlers wire up
   * against the new card cleanly; the still-live content is carried over
   * rather than dropped: the in-flight assistant segment (rebuilt and
   * continued) and any unfinished / failed tools (rebuildToolsOnRotate
   * moves them, Reads split out), while already-finished tools stay on
   * the old card. */
  private startMidTurnRotate(turn: TurnState): void {
    if (turn.rotating) return
    turn.rotateCount++
    const oldCardId = turn.cardId
    // 同步快照 tool 簿子 —— swap 会把这俩 Map 换成新的空 Map,旧对象仍被这俩
    // 引用持有(切卡 async 窗口里到达的新 tool 也继续 append 进旧 Map),
    // rebuildToolsOnRotate 用它们把"未完成/建失败"的 tool 搬到新卡。
    // assistant 段不在这里快照:它要带的是 swap 那一刻的最新全文(含切卡窗口期
    // 的 delta),所以放到 swap 时再读 —— 配合 appendAssistant onFailure 在
    // rotating 期间不 reset,这段会一直累积到 swap,窗口期的字一个不丢。
    const oldToolByUseId = turn.toolByUseId
    const oldBatches = turn.readBatches
    turn.rotating = (async () => {
      try {
        log(`session "${this.sessionName}": mid-turn rotate triggered card=${oldCardId.slice(0, 8)}… elementCount=${cardkit.getElementCount(oldCardId)}`)
        const card = cards.mainConversationCard({
          sessionName: this.sessionName,
          turn: this.turnCounter,
          provider: this.proc?.provider ?? this.selectedProvider,
          model: this.currentModelLabel() ?? undefined,
          effort: this.currentEffortLabel(),
          kind: 'card_full',
          userInputs: [],
        })
        const newMessageId = await feishu.sendCard(this.chatId, card)
        if (!newMessageId) {
          log(`session "${this.sessionName}": mid-turn rotate sendCard EXHAUSTED — staying on old card,subsequent adds will drop`)
          await feishu.sendTextRaw(
            this.chatId,
            '⚠️ 卡片元素超出飞书上限,本轮后续输出仅日志可见(开新卡失败)。',
          )
          return
        }
        let newCardId: string
        try { newCardId = await cardkit.convertMessageToCard(newMessageId) }
        catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate id_convert failed: ${e}`)
          return
        }
        // card_full body has banner(1) + footer(1) = 2 elements.
        cardkit.recordCardCreated(newCardId, 2, (code) => this.onCardWriteFailure(code))
        // 同步 swap：从这一行起,后续 stream handler 看到的 turn.cardId
        // 是新卡。reset 所有 element-id 引用 (toolCount / assistantSegmentCount
        // 等),旧卡上的 element_id 在新卡里查不到,继续 PUT 会 300313。
        this.stopFooterStatus(turn)
        turn.cardId = newCardId
        turn.messageId = newMessageId
        turn.toolCount = 0
        turn.toolByUseId = new Map()
        turn.readBatches = new Map()
        turn.openReadBatchI = null
        turn.planUpdateCount = 0
        turn.goalUpdateCount = 0
        // swap 那一刻读当前正在写的段(含切卡 async 窗口里到达的全部 delta ——
        // onFailure 在 rotating 期间不 reset,所以这段一直累积到这里)。先读后清。
        const carrySegId = turn.currentAssistantSegmentId
        const carryText = (turn.currentAssistantText ?? '').trim()
        const oldSegmentTexts = turn.segmentTexts
        turn.assistantSegmentCount = 0
        turn.currentAssistantSegmentId = null
        turn.currentAssistantText = ''
        turn.segmentTexts = new Map()
        if (carryText) this.startWritingFooter(turn)
        else this.startThinkingFooter(turn)
        // 先在新卡重建实时任务总览区(紧贴 footer)。必须在 assistant/tool 重建
        // 之前 —— 后者 insert_before taskLiveAnchor(turn),live 区没建就会指向
        // 不存在的 target 而写入失败。taskLiveInserted 是 turn 级 flag,swap 不重置,
        // 新卡照搬本 turn 是否建过实时区,保证换卡后任务总览不丢。
        if (turn.taskLiveInserted) {
          void cardkit.addElement(turn.cardId, cards.taskBoardLiveElement(this.taskBoard), {
            type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
          })
        }
        // 已完成但在旧卡插入失败的 assistant 段也要搬到新卡。正文现在是
        // block 完成后一次性 addElement；如果这个 addElement 撞上元素上限,
        // cardkit 会把旧元素标 dead 并触发轮转,这里负责补显示。
        for (const [segId, fullText] of oldSegmentTexts) {
          if (carrySegId && carryText && segId === carrySegId) continue
          if (!cardkit.isDeadElement(oldCardId, segId)) continue
          const ri = turn.assistantSegmentCount++
          const reSegId = cards.ELEMENTS.assistant(ri)
          turn.segmentTexts.set(reSegId, fullText)
          void cardkit.addElement(newCardId, this.completedAssistantElement(reSegId, fullText), {
            type: 'insert_before',
            targetElementId: sessionTools.taskLiveAnchor(turn),
          })
        }
        // 把"还在跑 / 建失败"的 tool 搬到新卡(已完成的留旧卡),Read 切开重建。
        sessionTools.rebuildToolsOnRotate(this, oldCardId, newCardId, oldToolByUseId, oldBatches)
        // 当前 assistant 段还没收尾就换卡时,整段只迁移内存缓冲到新卡继续收。
        // 正文要等 block_stop / turn close 后一次性插入,不在新旧卡上打字。
        if (carrySegId && carryText) {
          const ri = turn.assistantSegmentCount++
          const reSegId = cards.ELEMENTS.assistant(ri)
          turn.currentAssistantSegmentId = reSegId
          turn.currentAssistantText = carryText
          turn.segmentTexts.set(reSegId, carryText)
        }
        // 旧卡收尾:footer 红字 + streaming_off + dispose。放到 swap 后
        // 是因为这条链是 async,期间 cardkit 队列上还可能有 add/replace 等;
        // 让它们排在 footer 之前,视觉更连贯。
        try {
          await cardkit.flush(oldCardId)
          // 旧卡上已完成的 assistant 段做最终替换。当前迁移中的半段尚未
          // 插入旧卡,直接跳过,避免同一段同时出现在两张卡上。
          for (const [segId, fullText] of oldSegmentTexts) {
            if (carrySegId && carryText && segId === carrySegId) continue
            if (cardkit.isDeadElement(oldCardId, segId)) continue
            await cardkit.replaceElement(oldCardId, segId, {
              tag: 'markdown',
              element_id: segId,
              content: this.cleanAssistantTextForDisplay(fullText).trim() || ' ',
            })
          }
          const compactNote = turn.contextCompactCount > 0
            ? ` · 🚨 压缩×${turn.contextCompactCount}`
            : ''
          await this.replaceFooterContent(oldCardId, this.withModel(`📨 已续至下一张卡 ↓${compactNote}`))
          cardkit.cancelSummary(oldCardId)
          await cardkit.patchSettings(oldCardId, cards.streamingOffSettings({ suffix: '📨 转下一张' }))
          await cardkit.dispose(oldCardId)
        } catch (e) {
          log(`session "${this.sessionName}": mid-turn rotate close-old failed: ${e}`)
        }
        log(`session "${this.sessionName}": mid-turn rotate done old=${oldCardId.slice(0, 8)}… new=${newCardId.slice(0, 8)}…`)
      } finally {
        turn.rotating = null
      }
    })()
  }

  // Stream-event handlers are intentionally SYNCHRONOUS. Every cardkit op
  // is queued (per-card Promise chain in cardkit.ts), so we fire-and-
  // forget here and rely on enqueue source order — that way no `await`
  // can yield mid-handler and let `closeTurnCard` (or another event) race
  // and mutate `this.currentTurn` underfoot.

  private addPlanSnapshotOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn || turn.planSteps.length === 0) return
    this.maybeMidTurnRotate()
    const cardId = turn.cardId
    const elementId = cards.ELEMENTS.planUpdate(turn.planUpdateCount++)
    void cardkit.addElement(cardId, cards.planElement(turn.planSteps, turn.planExplanation, '', elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalUpdateOnCurrentTurn(goal: cards.ThreadGoal): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, cards.goalElement(goal, elementId), {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private addGoalClearedOnCurrentTurn(): void {
    const turn = this.currentTurn
    if (!turn) return
    this.maybeMidTurnRotate()
    const elementId = cards.ELEMENTS.goalUpdate(turn.goalUpdateCount++)
    void cardkit.addElement(turn.cardId, {
      tag: 'markdown',
      element_id: elementId,
      content: '**🎯 当前目标**\n\n已清除',
    }, {
      type: 'insert_before',
      targetElementId: sessionTools.taskLiveAnchor(turn),
    })
  }

  private handleContextCompacted(notice: ContextCompactedNotification): void {
    const turn = this.currentTurn
    if (!turn) {
      if (this.manualContextCompactionPending) {
        log(`session "${this.sessionName}": manual context compaction ${notice.phase ?? 'event'} with no current turn`)
        return
      }
      if (notice.phase === 'start') {
        log(`session "${this.sessionName}": context compaction start with no current turn`)
        return
      }
      log(`session "${this.sessionName}": context compacted with no current turn`)
      const backend = this.proc ? this.backendLabel(this.proc.provider) : this.backendLabel()
      void feishu.sendTextRaw(this.chatId, `🚨🚨🚨 CONTEXT COMPACTED / 上下文已压缩 🚨🚨🚨\n\n${backend} 报告发生了上下文压缩,但当前没有可写的对话卡片。`)
      return
    }
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    this.maybeMidTurnRotate()
    if (notice.phase === 'start') {
      const i = turn.contextCompactCount++
      const key = compactionKey(notice)
      turn.contextCompactionPending.set(key, { i, cardId: turn.cardId, notice })
      const elementId = cards.ELEMENTS.contextCompact(i)
      log(`session "${this.sessionName}": context compaction start #${i + 1} key=${key}`)
      void cardkit.addElement(turn.cardId, cards.contextCompactionElement(i, notice, elementId), {
        type: 'insert_before',
        targetElementId: sessionTools.taskLiveAnchor(turn),
      })
      cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
      return
    }
    const key = notice.itemId && turn.contextCompactionPending.has(notice.itemId)
      ? notice.itemId
      : latestPendingCompactionKey(turn)
    const pending = key ? turn.contextCompactionPending.get(key) : undefined
    if (key) turn.contextCompactionPending.delete(key)
    const merged = mergeCompactionNotices(pending?.notice, notice)
    const i = pending?.i ?? turn.contextCompactCount++
    const cardId = pending?.cardId ?? turn.cardId
    const elementId = cards.ELEMENTS.contextCompact(i)
    log(`session "${this.sessionName}": context compaction completed #${i + 1}${key ? ` key=${key}` : ''}`)
    if (pending) {
      void cardkit.replaceElement(cardId, elementId, cards.contextCompactionElement(i, merged, elementId))
    } else {
      void cardkit.addElement(cardId, cards.contextCompactionElement(i, merged, elementId), {
        type: 'insert_before',
        targetElementId: sessionTools.taskLiveAnchor(turn),
      })
    }
    cardkit.patchSummaryThrottled(turn.cardId, `🚨 压缩×${turn.contextCompactCount}`)
  }

  private handleTurnPlanUpdated(update: TurnPlanUpdated): void {
    const turn = this.currentTurn
    if (!turn) {
      log(`session "${this.sessionName}": turn/plan/updated with no current turn`)
      return
    }
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    if (!Array.isArray(update.plan)) {
      log(`session "${this.sessionName}": turn/plan/updated missing plan array`)
      turn.planSteps = []
    } else {
      turn.planSteps = update.plan.map(step => ({
        step: typeof step.step === 'string' && step.step ? step.step : 'MISS',
        status: typeof step.status === 'string' && step.status ? step.status : 'MISS',
      }))
    }
    turn.planExplanation = typeof update.explanation === 'string' ? update.explanation : null
    this.addPlanSnapshotOnCurrentTurn()
  }

  private handlePlanDelta(delta: PlanDelta): void {
    if (typeof delta.delta !== 'string' || !delta.delta) {
      log(`session "${this.sessionName}": item/plan/delta missing delta text`)
      return
    }
    if (typeof delta.itemId !== 'string' || !delta.itemId) {
      log(`session "${this.sessionName}": item/plan/delta missing itemId`)
    }
  }

  private handleThreadGoalUpdated(goal: ThreadGoal): void {
    if (!goal || typeof goal.objective !== 'string') {
      log(`session "${this.sessionName}": thread/goal/updated missing objective`)
      return
    }
    if (goal.tokenBudget != null && typeof goal.tokenBudget !== 'number') {
      log(`session "${this.sessionName}": thread/goal/updated invalid tokenBudget`)
    }
    const previousGoal = this.currentGoal
    const currentGoal: cards.ThreadGoal = {
      objective: goal.objective,
      status: typeof goal.status === 'string' && goal.status ? goal.status : 'MISS',
      tokenBudget: typeof goal.tokenBudget === 'number'
        ? goal.tokenBudget
        : goal.tokenBudget === null
          ? null
          : Number.NaN,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : Number.NaN,
      timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : Number.NaN,
    }
    this.currentGoal = currentGoal
    if (
      previousGoal &&
      cards.goalDisplaySignature(previousGoal) === cards.goalDisplaySignature(currentGoal)
    ) {
      return
    }
    const turn = this.currentTurn
    if (turn) {
      this.startWorkingFooter(turn)
      if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
      turn.openReadBatchI = null
    }
    this.addGoalUpdateOnCurrentTurn(currentGoal)
  }

  private handleThreadGoalCleared(): void {
    if (!this.currentGoal) return
    this.currentGoal = null
    const turn = this.currentTurn
    if (!turn) return
    this.startWorkingFooter(turn)
    if (turn.currentAssistantSegmentId) this.finalizeCurrentAssistantSegment()
    turn.openReadBatchI = null
    this.addGoalClearedOnCurrentTurn()
  }

  private appendAssistant(delta: string): void {
    if (!this.currentTurn) {
      // 只在合法无卡窗口缓冲:正在开卡(openingTurn),或恢复轮开卡失败后
      // 的续窗(bgResumeCardless)。其余无卡场景(被打断的轮尾、进程 kill
      // 窗口的残字、轮间游离 delta)一律丢弃 —— 缓冲下来只会被错误推送或
      // 并入下一张不相干的卡(旧代码此处直接 return 丢弃,行为一致)。
      if (this.openingTurn || this.bgResumeCardless) this.orphanAssistantCurrent += delta
      return
    }
    const turn = this.currentTurn
    // 第一条 assistant text_delta 到达 → footer 切到 Writing 计时。
    // 正文自身只进入内存缓冲,等 agentMessage completed 后一次性插入卡片。
    this.startWritingFooter(turn)
    if (!turn.currentAssistantSegmentId) {
      // New assistant segment opens a visual break — any prior Read run
      // is now visually separated from future Reads, so close the batch
      // window. Future Reads will start a fresh batch at a new i.
      turn.openReadBatchI = null
      // Pre-empt the "element exceeds the limit" 300305/300315 cliff —
      // if the card's element count is approaching Feishu's cap, fire-and-
      // forget kick off a mid-turn rotation onto a fresh card before this
      // buffered segment is eventually inserted. The rotation handler resets
      // turn state once the new card is up so subsequent stream handlers see
      // the new cardId.
      this.maybeMidTurnRotate()
      const i = turn.assistantSegmentCount++
      const segId = cards.ELEMENTS.assistant(i)
      turn.currentAssistantSegmentId = segId
      turn.currentAssistantText = ''
    }
    turn.currentAssistantText += delta
    const segId = turn.currentAssistantSegmentId
    if (!segId) return
    turn.segmentTexts.set(segId, turn.currentAssistantText)
    this.processOutboundMarkers(turn.currentAssistantText)
    this.processHostAskMarkers(turn.currentAssistantText, turn)
    const displayText = this.cleanAssistantTextForDisplay(turn.currentAssistantText)
    // Chat-list preview: tail of the latest assistant text. Feishu
    // truncates anyway; ~60 chars is what shows on a typical phone
    // preview line. patchSummaryThrottled is rate-limited on its own.
    const tail = displayText.slice(-60)
    cardkit.patchSummaryThrottled(turn.cardId, tail)
  }

  /** 取走并清空孤儿 assistant 缓冲(定稿段 + 未定稿尾段,空行分隔)。 */
  private takeOrphanAssistantText(): string {
    const parts = [...this.orphanAssistantSegments]
    if (this.orphanAssistantCurrent.trim()) parts.push(this.orphanAssistantCurrent)
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    return parts.join('\n\n').trim()
  }

  /** 丢弃孤儿缓冲并复位 cardless 续窗标记 —— 用户主动作废(打断/停止/重启)
   *  或进程被替换时调用,内容随轮作废不兜底。 */
  private discardOrphanAssistant(): void {
    this.orphanAssistantSegments = []
    this.orphanAssistantCurrent = ''
    this.bgResumeCardless = false
  }

  /** 无卡兜底:孤儿正文以纯文本消息推进聊天 —— 宁可丢排版,不可丢内容。 */
  private flushOrphanAssistantToChat(reason: string): void {
    const text = this.takeOrphanAssistantText()
    if (!text) return
    const display = this.cleanAssistantTextForDisplay(text).trim()
    if (!display) return
    log(`session "${this.sessionName}": flushing ${display.length} chars of orphan assistant text (${reason})`)
    void feishu.sendText(this.chatId, `📄 后台轮输出(未能建卡,纯文本兜底):\n\n${display}`)
  }

  private completedAssistantElement(segId: string, text: string): object {
    return {
      tag: 'markdown',
      element_id: segId,
      content: this.cleanAssistantTextForDisplay(text).trim() || ' ',
    }
  }

  private addCompletedAssistantSegment(turn: TurnState, segId: string, text: string): Promise<void> {
    return cardkit.addElement(
      turn.cardId,
      this.completedAssistantElement(segId, text),
      { type: 'insert_before', targetElementId: sessionTools.taskLiveAnchor(turn) },
    )
  }

  /** 收尾当前 assistant 段:正文不再逐字流式输出,只在完整段收到后
   * 一次性插入静态 markdown,然后清空段游标。 */
  finalizeCurrentAssistantSegment(): void {
    const turn = this.currentTurn
    if (!turn) {
      // 无卡窗口的段边界:当前孤儿段定稿进列表,flush 时段间以空行分隔。
      if (this.orphanAssistantCurrent.trim()) this.orphanAssistantSegments.push(this.orphanAssistantCurrent)
      this.orphanAssistantCurrent = ''
      return
    }
    // 正在切卡:别动当前段 —— rotate 会在 swap 时读 currentAssistantText carry
    // 到新卡续写。这里若定稿/reset,过渡窗口里的当前段文字会被清空、carry 落空
    // (跟 appendAssistant onFailure 在 rotating 期间不 reset 同一个道理)。代价是
    // 切卡窗口恰好跨 block 边界时两段可能并作一段 —— 不丢内容,可接受。
    if (turn.rotating) return
    const segId = turn.currentAssistantSegmentId
    const text = turn.currentAssistantText ?? ''
    if (segId && text.trim()) {
      void this.addCompletedAssistantSegment(turn, segId, text)
      this.startWorkingFooter(turn)
    }
    turn.currentAssistantSegmentId = null
    turn.currentAssistantText = ''
  }

  /** 从一段文字里找完整 [[send: /abs/path]] 标记,一看到就立即发。正文保留
   * 原标记不改,让用户知道触发了哪个文件路径。 */
  private processOutboundMarkers(text: string): void {
    for (const path of extractSendMarkerPaths(text)) {
      this.sendOutboundPath(path, 'send marker')
    }
  }

  private processHostAskMarkers(text: string, turn: TurnState): void {
    if (this.proc?.provider !== 'codex') return
    for (const marker of extractAskUsrMarkers(text)) {
      if (turn.hostAskMarkersSeen.has(marker.raw)) continue
      turn.hostAskMarkersSeen.add(marker.raw)
      sessionHostAsk.queueHostAskFromMarker(this, marker.payload, marker.raw)
    }
  }

  private cleanAssistantTextForDisplay(text: string): string {
    const replacement = this.proc?.provider === 'codex'
      ? '\n\n_已发起澄清问题，请回答对应卡片。_'
      : ''
    return stripAskUsrMarkers(text, replacement)
  }

  sendOutboundPath(rawPath: string, source: string): void {
    const p = rawPath.trim()
    if (!p) return
    const turn = this.currentTurn
    if (turn?.outboundSeenPaths.has(p)) return
    turn?.outboundSeenPaths.add(p)
    if (!isAbsolute(p)) {
      log(`session "${this.sessionName}": ignore non-absolute outbound path from ${source}: ${p}`)
      return
    }
    turn?.outboundSentPaths.add(p)
    log(`session "${this.sessionName}": outbound send from ${source}: ${p}`)
    void feishu.uploadAndSend(this.chatId, p)
  }

  /** Start or switch the turn footer phase. It lives in the stable footer
   * element and uses replaceElement so status updates appear immediately
   * instead of invoking Feishu's typewriter. */
  private startFooterStatus(turn: TurnState, status: string): void {
    // log-only 之后 phase 切换(Thinking/Writing/Working)不许把每秒
    // ticker 重新拉起来 —— 卡已标记拒写,计时纯属空转。
    if (turn.rotateGivenUp) return
    if (turn.footerStatusHandle && turn.footerStatusLabel === status) return
    this.stopFooterStatus(turn)
    turn.footerStatusLabel = status
    turn.footerStatusStartedAt = Date.now()
    const render = (): void => {
      if (turn.footerStatusHandle == null || !turn.footerStatusLabel) return
      const elapsedS = Math.max(0, Math.floor((Date.now() - turn.footerStatusStartedAt) / 1000))
      void this.replaceFooterContent(turn.cardId, this.withModel(`${turn.footerStatusLabel}(${elapsedS}s)`))
    }
    turn.footerStatusHandle = setInterval(render, FOOTER_STATUS_TICK_MS)
    render()
  }

  startThinkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_THINKING_PREFIX)
  }

  startWritingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WRITING)
  }

  startWorkingFooter(turn: TurnState): void {
    this.startFooterStatus(turn, FOOTER_WORKING)
  }

  stopFooterStatus(turn: TurnState | null): void {
    if (!turn) return
    if (turn.footerStatusHandle) clearInterval(turn.footerStatusHandle)
    turn.footerStatusHandle = null
    turn.footerStatusStartedAt = 0
    turn.footerStatusLabel = null
  }

  /** turn footer 末尾的 5h 额度后缀(`  |  5h·N%·[Xh]`),按当前 provider:
   *   claude/GLM → readGlmUsage(轻量 HTTP,主动拉当前 5h 窗口)
   *   codex      → peekUsage(turn 中 updateUsageFromRateLimits 已更新 cache,
   *                纯读不 fetch,避免每轮为一个百分比 spawn codex app-server)
   * 拿不到百分比就返回空串;resetsAt 在未来时追加剩余重置时长
   * (`·[2.3h]`),缺数据不硬凑 —— footer 不假数据 (no_fallbacks)。 */
  private async footerFiveHourSuffix(): Promise<string> {
    let pct: number | null = null
    let resetsAt: Date | null = null
    if (this.proc?.provider === 'claude') {
      const g = await readGlmUsage()
      if (g.state === 'ok') {
        pct = g.fiveHour?.percent ?? null
        resetsAt = g.fiveHour?.resetsAt ?? null
      }
    } else {
      const u = peekUsage()
      if (u?.state === 'ok') {
        pct = u.fiveHour?.percent ?? null
        resetsAt = u.fiveHour?.resetsAt ?? null
      }
    }
    if (pct == null) return ''
    const resetIn = resetsAt && resetsAt.getTime() > Date.now() ? cards.fmtResetIn(resetsAt) : ''
    return resetIn ? `  |  5h·${Math.round(pct)}%·[${resetIn}]` : `  |  5h·${Math.round(pct)}%`
  }

  async closeTurnCard(
    suffix?: string,
    opts: { forcePush?: boolean; hasFreshResult?: boolean } = {},
  ): Promise<void> {
    // CRITICAL: capture-and-null in a single synchronous block at entry
    // so a parallel `closeTurnCard` (e.g. result event firing while
    // onUserMessage is awaiting an interrupt) can't double-process the
    // same turn — second caller observes null and bails. The promised
    // sync-handler invariant only protects callers that take the turn
    // off the table BEFORE their first await.
    const turn = this.currentTurn
    if (!turn) return
    this.currentTurn = null
    this.stopFooterStatus(turn)
    // 竞态修复:mid-turn rotation 的 swap 阶段(sendCard / id_convert 的 await
    // 之后,见 startMidTurnRotate)会切 turn.cardId 到新卡并 startWritingFooter
    // 重启一个 footer 计时 interval。若 result 在那个 await 窗口里抢先到达,
    // 本函数会先终态化旧卡、置 currentTurn=null,随后 swap 才重启 interval ——
    // 该 interval 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到的是 null),新卡 footer 一直计时。
    // 首 turn 长输出触发 rotation 时必现(2026-06-26 turn=1 计时不止)。等
    // rotating 落定后再终态化:turn.cardId 此时是新卡,再 stop 一次清掉 swap
    // 重启的 interval,终态 footer 也写在新卡上。
    if (turn.rotating) await turn.rotating
    this.stopFooterStatus(turn)
    const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1)
    const cardId = turn.cardId
    const segmentTexts = turn.segmentTexts
    await cardkit.flush(cardId)

    // [[send: /abs/path]] markers are handled while deltas are received by
    // processOutboundMarkers(). closeTurnCard only finalizes text display.
    // 如果最后一个 assistant 段没有等到 block_stop,这里先把内存缓冲的完整
    // 文本作为静态 markdown 插入卡片。
    if (turn.currentAssistantSegmentId && turn.currentAssistantText.trim()) {
      await this.addCompletedAssistantSegment(turn, turn.currentAssistantSegmentId, turn.currentAssistantText)
      turn.currentAssistantSegmentId = null
      turn.currentAssistantText = ''
    }

    // 对每个 assistant 段 replaceElement 成最终内容。正文已经是静态 markdown,
    // 这里只是收尾清洗 askusr 标记和兜住异常路径。
    for (const [segId, fullText] of segmentTexts) {
      await cardkit.replaceElement(cardId, segId, this.completedAssistantElement(segId, fullText))
    }

    // State marker leads the footer (✅ for natural completion, or the
    // suffix verbatim for non-natural states like `🛑 打断`). The
    // trailing "done" word is gone — the ✅ already carries that
    // meaning. User-confirmed footer order 2026-05-16.
    const stateMark = suffix ? suffix : '✅'
    // Footer line 1 keeps the terminal status compact. Usage-derived
    // numbers only render when a fresh SDK result landed for THIS turn;
    // interrupts/boot failures would otherwise show stale prior-turn data.
    const line1Parts = [`${stateMark} ⏱ ${elapsed}s`]
    if (opts.hasFreshResult) {
      const ctxTokens = this.currentContextTokens()
      const ctxMax = this.contextLimitForDisplay()
      // Claude 路径分母已是 SDK 实测窗口、分子是输入侧占用,走纯除法(baseline=0);
      // Codex 路径保留 12K baseline 扣减。
      const isClaude = this.proc?.provider === 'claude'
      const ctxPercent = cards.footerContextPercentLabel(ctxTokens, ctxMax, isClaude ? 0 : undefined)
      if (ctxPercent) line1Parts.push(`🧠 ${ctxPercent}`)
      const cost = this.lastTurnDelta?.costUsd ?? 0
      if (cost > 0) line1Parts.push(`💰 $${cost.toFixed(3)}`)
    }
    if (turn.contextCompactCount > 0) line1Parts.push(`🚨 压缩×${turn.contextCompactCount}`)
    if (turn.outboundSentPaths.size > 0) line1Parts.push(`📎 ${turn.outboundSentPaths.size}`)
    const modelLabel = this.modelLine()
    if (modelLabel) line1Parts.push(modelLabel)
    const footerLine1 = line1Parts.join(' ｜ ')
    const footerLine2 = opts.hasFreshResult
      ? cards.footerTokenDetailLine(this.lastTurnUsage) + (turn.rotateGivenUp ? '' : await this.footerFiveHourSuffix())
      : ''
    const footer = footerLine2 ? `${footerLine1}\n${footerLine2}` : footerLine1
    await this.replaceFooterContent(cardId, footer)
    // Final chat-list preview: clean finish shows "⏱ Xs · NK tokens";
    // interrupted shows the suffix instead (no usage event landed).
    // cancelSummary kills any in-flight throttled write so a stale
    // in-flight summary update can't clobber this terminal summary.
    cardkit.cancelSummary(cardId)
    await cardkit.patchSettings(cardId, cards.streamingOffSettings({
      durationSec: elapsed,
      outputTokens: opts.hasFreshResult ? this.lastTurnUsage?.output_tokens : undefined,
      suffix,
    }))
    await cardkit.dispose(cardId)

    // Phone push on clean turn close so the user knows Codex is done
    // even with the chat backgrounded. Skip on interrupts (no real
    // completion), when we don't know who to ping, and when the turn
    // wasn't kicked off by the user typing a message. `opts.forcePush`
    // overrides the suffix-gate for the
    // "consecutive SDK errors, giving up" case — that close has a non-
    // empty suffix but the user still needs to know we bailed.
    // Fire-and-forget; urgent_app failures are non-fatal and already
    // logged in feishu.ts.
    // log-only 的 turn 已发过"仅日志可见"告警,用户知晓 —— 不再为
    // 一张写死的卡响手机推送(2026-07-04 review follow-up)。
    if ((opts.forcePush || !suffix) && turn.userOpenId && turn.messageId && !turn.rotateGivenUp) {
      void feishu.urgentApp(turn.messageId, [turn.userOpenId])
    }

    // Release the OneSecond reactions on every queued Feishu message
    // this turn was responsible for. Two buckets:
    //   1. `currentBatchReactionIds` — msgs the init handler explicitly
    //      claimed (SDK dequeued them as a merged next-turn batch).
    //   2. `pendingReactionIds` — msgs whose fate is invisible to the
    //      daemon: the SDK either dequeued them as part of the
    //      JUST-CLOSED turn OR injected them mid-turn as
    //      `<system-reminder>` and silently removed them from the
    //      queue (common when the current turn had tool calls).
    //      Without visibility into queue-operation events the daemon
    //      can't tell which; the safe default is "the prior turn just
    //      ended, so the msg is at least *acknowledged* now —
    //      release the OneSecond and let it stop saying 'queued',
    //      instead of leaving it stuck permanently."
    //      For merged-batch follow-ups, this releases slightly early
    //      (before the merged turn actually runs), which is an
    //      acceptable trade vs. msgs stuck under OneSecond forever.
    const releaseEntries = [
      ...this.currentBatchReactionIds.entries(),
      ...this.pendingReactionIds.entries(),
    ]
    if (releaseEntries.length > 0) {
      for (const [msgId, rid] of releaseEntries) {
        if (rid) void feishu.deleteReaction(msgId, rid)
      }
      this.currentBatchReactionIds = new Map()
      this.pendingReactionIds = new Map()
    }
  }
}
