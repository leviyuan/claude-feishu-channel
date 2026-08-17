/**
 * Shared types split out of session.ts so the main file stays under
 * agent per-read token budgets. Pure type-only — no
 * runtime imports here. Companion modules: session-tools.ts,
 * session-ask.ts, session-permission.ts.
 */

import type { AgentProvider, AgentReasoningEffort } from './agent-process'

export interface TurnState {
  cardId: string
  /** 本轮开卡时实际运行的后端快照。持久模型选择可指向下一轮，不能反过来
   * 改写已经在跑的 turn footer。 */
  provider: AgentProvider
  model: string | null
  effort: AgentReasoningEffort
  /** Feishu message_id of the card — needed for urgent_app push on clean
   * turn close. Kept separate from cardId because cardkit's stream APIs
   * operate on card_id but the urgent_app endpoint takes message_id. */
  messageId: string
  /** open_id of the user who started this turn. Used to scope the
   * urgent_app push so only the initiator gets pinged (in case there
   * are other members in the group). Empty string → skip the ping. */
  userOpenId: string
  /** What kicked off this turn. Kept explicit for turn lifecycle logic.
   *   'user_message'   — 用户消息批次
   *   'bg_task_resume' — 后台任务结算后 SDK 自发的恢复轮(无用户消息;
   *                      不开卡的话整轮正文会被丢弃) */
  trigger: 'user_message' | 'bg_task_resume'
  toolCount: number
  /** `output` / `isError` are filled in by completeTool and kept so
   * card rotation can rebuild unfinished or failed tool panels. */
  toolByUseId: Map<string, {
    i: number
    name: string
    input: any
    resolvedNote?: string
    output?: string
    isError?: boolean
    /** Set when this tool is part of a merged file-tool batch (Read run or
     * Edit run) — points to the batch's slot in `toolBatches[i].items`.
     * completeTool uses it to update the right row instead of rendering
     * a standalone panel. */
    batchSlot?: number
  }>
  /** Current turn plan as reported by Codex app-server
   * turn/plan/updated. Deltas are only for the pre-authoritative
   * planning draft shown before this structure lands. */
  planSteps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' | string }>
  planExplanation: string | null
  planUpdateCount: number
  goalUpdateCount: number
  contextCompactCount: number
  contextCompactionPending: Map<string, { i: number; cardId: string; notice: any }>
  /** Consecutive file-tool calls collapse into a single panel: `Read` runs
   * render via `cards.readBatchElement`, `Edit`/`MultiEdit`/`NotebookEdit`
   * runs via `cards.editBatchElement`. Keyed by element index `i` so
   * completeTool can find the batch after its open-window closed (a
   * different-kind tool or new assistant segment has since arrived).
   *
   * `openBatchI` is the i of the batch currently accepting new calls of
   * its own kind; null once the run ends. A run of a different kind (or
   * any non-batch tool) closes the window — subsequent calls open a fresh
   * batch at a new i. */
  toolBatches: Map<number, {
    kind: 'read' | 'edit'
    items: Array<{ toolUseId: string; input: any; output: string | null; isError: boolean }>
  }>
  openBatchI: number | null
  /** Task 工具按类型分两个合并槽(连续同类调用复用同一面板,切类则前一类定稿):
   * - taskCreateI:连续 TaskCreate 合并成"创建任务"面板(列待办,按 #1#2#3 顺序),
   *   遇到任何非 Create 工具(含 TaskUpdate)即定稿,board 后续变化不再回写它。
   * - taskUpdateI:连续 TaskUpdate/List/Get 合并成"进度快照"面板(复制任务列表
   *   + 标记进行中/完成),遇到非该类工具即定稿。形成 timeline:
   *   创建面板(全待办) → 进度快照1 → 进度快照2 → ...
   *   null = 该类本 turn 还没活动槽。board 累积在 session 级(session.taskBoard)。 */
  taskCreateI: number | null
  taskUpdateI: number | null
  /** 2b 懒清空:本 turn 是否已因首次 TaskCreate 把 session.taskBoard 清空过。
   *  首次 TaskCreate 清空(=换主题重建整张清单),同 turn 后续 TaskCreate 累积;
   *  下个 turn 首次 TaskCreate 再清空。只 TaskUpdate/List/Get 不清空(同任务延续)。
   *  per-turn,openTurnCard 初始化为 false。 */
  taskBoardResetThisTurn: boolean
  /** 实时任务总览区(task_board_live)是否已在本 turn 卡片建立。首个 Task 工具触发
   *  建立(footer 正前),之后每次 Task 工具 add/complete 都 replace 内容。换卡时
   *  rebuildToolsOnRotate 在新卡重建。建立后它成为插入锚点 —— 后续过程元素
   *  insert_before 它而非 footer(见 session-tools.taskLiveAnchor)。per-turn。 */
  taskLiveInserted: boolean
  /** 实时计划区(plan_live)是否已在本 turn 卡片建立。codex 首次 turn/plan/updated
   *  触发建立(任务总览正上、footer 正前),之后每次 plan 更新 replace 成最新快照,
   *  让最新计划永远压在卡片末尾(对齐 claude 侧任务总览的常驻语义)。per-turn,
   *  swap 不重置(换卡由 startMidTurnRotate 重建)。 */
  planLiveInserted: boolean
  assistantSegmentCount: number
  currentAssistantSegmentId: string | null
  currentAssistantText: string
  // Per-assistant-segment cumulative text — used at turn close to strip
  // [[send: /path]] markers and replace each segment with a cleaned
  // version, then post the files as separate Feishu messages.
  segmentTexts: Map<string, string>
  startedAt: number
  /** Footer phase timer. `Thinking` is model silence, `Writing` is buffered
   * assistant text, and `Working` is tool execution / visible non-text work. */
  footerStatusHandle: ReturnType<typeof setInterval> | null
  footerStatusStartedAt: number
  footerStatusLabel: string | null
  /** Mid-turn card-rotation lock. Set when we've fire-and-forget kicked
   * off `startMidTurnRotate` to open a fresh card — either proactively
   * (element count crossed CARD_ELEMENT_SOFT_LIMIT) or reactively (an
   * addElement write was rejected by Feishu — see onCardWriteFailure).
   * Stays set until rotation completes so concurrent stream handlers
   * don't all queue duplicate rotation attempts. null means "no rotation
   * in flight". */
  rotating: Promise<void> | null
  /** How many times this turn has rotated to a fresh card, proactive and
   * reactive combined. Informational (logging) — NOT what the cap reads.
   * Reset per turn (a fresh TurnState starts at 0). */
  rotateCount: number
  /** Rotations triggered by the reactive failure path only
   * (onCardWriteFailure). This is the counter MAX_MIDTURN_ROTATES caps —
   * the failure path is the only one that can run away (Feishu outage, or
   * a poisoned element that fails on every card). The proactive path
   * (maybeMidTurnRotate) deliberately does NOT consume this budget: it
   * needs ~50 genuinely-successful elements per card to fire again, so
   * it's naturally throttled by real output. Sharing one counter was the
   * 2026-07-04 bug — a long turn's 5 legitimate full-card rotations
   * exhausted the cap, and the next transient 300308 flipped the turn to
   * log-only. */
  failureRotateCount: number
  /** Latched once we hit the rotate cap and emit the "giving up" notice,
   * so the notice isn't repeated on every later failed write this turn. */
  rotateGivenUp: boolean
  /** 本 turn 已处理过的出站路径请求。包括合法绝对路径和被拒绝的非绝对路径,
   * 用来避免增量文本反复扫到同一个 [[send: ...]] 时重复上传或刷日志。 */
  outboundSeenPaths: Set<string>
  /** 已实际排队上传的绝对路径。用于 footer 计数和跨 rotate 去重。 */
  outboundSentPaths: Set<string>
  /** 已识别过的宿主 askusr marker 原文。assistant 文本是累积增量，
   * 不去重会在每次 delta 上重复建 ask 卡。 */
  hostAskMarkersSeen: Set<string>
}

export type Status = 'idle' | 'working' | 'awaiting_permission' | 'starting' | 'stopped'

export interface SessionOpts {
  /** Daemon hook: persist its current alive-session snapshot whenever this
   * session starts, stops, exits, or changes process lifecycle. Scripts
   * that construct Session directly can omit it. */
  onLifecycleChange?: () => void
  /** Daemon hook:建临时群并在其中启动一个 session(btw 干净新会话 / fk 从锚点 fork)。
   *  resumeSessionId+resumeSessionAt 都给 fk(从历史点派生);btw 都不传 = 全新。
   *  返回 {ok, chatId};失败 ok=false 由调用方提示用户。*/
  onCreateTempSession?: (opts: {
    chatName: string
    userOpenId: string
    resumeSessionId?: string
    resumeSessionAt?: string
  }) => Promise<{ ok: boolean; chatId?: string; error?: string }>
  /** Daemon hook:解散临时群 + 清掉它的 Session 对象(bye 用)。*/
  onDisbandTempSession?: (chatName: string) => Promise<{ ok: boolean; error?: string }>
}

/** Per-turn delta extracted from the SDK `result` message — feeds the
 * "上一轮" line in the console panel. */
export interface LastTurnDelta {
  tokens: number | null // input + cache_creation + output for that turn; null 表示口径未知
  costUsd: number     // 可展示的本轮 dollar cost；Claude 后端不展示不可靠金额，固定为 0
  durationMs: number
}

/** Cumulative session counters. Reset on full restart (`clear`),
 * preserved across `restart`/resume and daemon-restart so the `hi`
 * panel reflects the user's total spend in this conversation
 * regardless of how many times the underlying CodexProcess has been
 * respawned. Resumed conversations start counting from the resume
 * point onward — the SDK doesn't replay historical usage on resume,
 * so a long pre-resume conversation shows up as zero here until the
 * first new turn lands. */
export interface CumStats {
  tokens: number
  costUsd: number
  turns: number
}
