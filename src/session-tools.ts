/**
 * Tool-tracking helpers split out of session.ts. Free functions taking
 * a Session; fields they touch are package-internal (no `private`
 * modifier on the class side). Cross-file boundary lets the main
 * session.ts stay small enough for agent review.
 */

import type { Session } from './session'
import type { TurnState } from './session-types'
import { isAbsolute } from 'node:path'
import { normalizeOutboundPath } from './outbound-markers'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'

/** 过程元素(tool/assistant/plan/goal/context_compact)的插入锚点:实时任务总览区
 * 建立后,新元素 insert_before 它(让实时区永远压在 footer 正前,过程记录堆在它
 * 上方、相对顺序不变);否则 insert_before footer(本 turn 没 Task 工具时,行为同
 * 改前)。turn=null 兜底 footer —— 调用方都在 turn 生命周期内,turn 非空,仅类型安全。 */
export function taskLiveAnchor(turn: TurnState | null | undefined): string {
  return turn?.taskLiveInserted ? cards.ELEMENTS.taskBoardLive : cards.ELEMENTS.footer
}

function isImageGenerationTool(name: string): boolean {
  return name === 'ImageGeneration' || name === 'imageGeneration'
}

export function autoSendPathFromToolResult(name: string, output: string, isError: boolean): string | null {
  if (isError || !isImageGenerationTool(name)) return null
  // 图片工具在 Windows git bash 下可能吐 /c/Users/... 的 MSYS 路径,
  // 归一化成 C:\Users\... 再校验,否则 statSync 会 ENOENT。
  const p = normalizeOutboundPath(output.trim())
  return isAbsolute(p) ? p : null
}

export function addTool(s: Session, toolUseId: string, name: string, input: any): void {
  if (!s.currentTurn) return
  // 元素接近上限时 fire-and-forget kick off mid-turn rotation。check 是
  // O(1) 的(只查 cardkit 内部计数 Map),即使 in-batch Read 续走 replace
  // 路径不会 +1 element,也无害 —— maybeMidTurnRotate 看到 count 没到
  // 阈值会直接 return。
  s.maybeMidTurnRotate()
  // 模型出第一个工具 → footer 切到 Working 计时。
  s.startWorkingFooter(s.currentTurn)
  // Close current assistant segment (if any) so the tool panel renders
  // AFTER it in card body order. The assistant body is inserted once as
  // static markdown before the tool element is inserted.
  if (s.currentTurn.currentAssistantSegmentId) {
    // 工具面板插在当前 assistant 段之后 → 先把该段完整全文插入为静态
    // markdown。content_block_stop 通常已先定稿过这段(那时 segId 已 reset,
    // 这里直接跳过),本调用是 block_stop 没覆盖时的兜底。
    s.finalizeCurrentAssistantSegment()
  }
  // Consecutive Read merger: if a Read run is already open, append to
  // its batch and re-render the panel instead of inserting a new one.
  // Any other tool name closes the run (handled below).
  if (name === 'Read' && s.currentTurn.openReadBatchI !== null) {
    const batchI = s.currentTurn.openReadBatchI
    const batch = s.currentTurn.readBatches.get(batchI)!
    const slot = batch.items.length
    batch.items.push({ toolUseId, input, output: null, isError: false })
    s.currentTurn.toolByUseId.set(toolUseId, { i: batchI, name, input, readBatchSlot: slot })
    const el = cards.readBatchElement(batchI, batch.items)
    void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(batchI), el)
    return
  }
  if (name !== 'Read') s.currentTurn.openReadBatchI = null
  // Claude Code Task 工具:整个流程复用本 turn 同一面板(codex 单面板效果),
  // 而非每次调用新建 —— 否则一次 TaskCreate×N + TaskUpdate×N 会堆成一串重复
  // 视图。board 累积在 session 级,这里只占/复用 element slot。
  const taskName = cards.asTaskToolName(name)
  if (taskName) {
    const turn = s.currentTurn
    // 2b 懒清空:本 turn 首次 TaskCreate → 清空 board(换主题重建整张清单,不再
    // 和上轮任务堆叠);同 turn 后续 TaskCreate 累积(不清)。TaskUpdate/List/Get
    // 不清空 —— 同任务跨 turn 延续时,它们要么按 id 改状态、要么 TaskList 全量
    // 替换,都该基于现有 board。清空只认"重新建任务"这个换主题信号。
    if (taskName === 'TaskCreate' && !turn.taskBoardResetThisTurn) {
      s.taskBoard = []
      turn.taskBoardResetThisTurn = true
    }
    // 实时任务总览区:本 turn 首个 Task 工具触发建立(insert_before footer,紧贴
    // footer),之后每次 Task 工具都 replace 成最新 board。建立后它成为插入锚点,
    // 后续过程元素 insert_before 它而非 footer(见 taskLiveAnchor),保证它永远
    // 压在 footer 正前。与 timeline 上的 taskBoardElement(折叠、记每次操作快照)
    // 并存 —— 那个是过程变更记录,这个是实时总览,对齐 claude cli 底部常驻 todo。
    if (!turn.taskLiveInserted) {
      turn.taskLiveInserted = true
      void cardkit.addElement(turn.cardId, cards.taskBoardLiveElement(s.taskBoard), {
        type: 'insert_before', targetElementId: cards.ELEMENTS.footer,
      })
    } else {
      void cardkit.replaceElement(turn.cardId, cards.ELEMENTS.taskBoardLive, cards.taskBoardLiveElement(s.taskBoard))
    }
    // 连续同类合并:TaskCreate→创建面板,TaskUpdate/List/Get→进度快照面板。
    // 切到另一类则前一类面板定稿(不再更新);board 始终累积。timeline 效果:
    // 创建面板(全待办) → 进度快照(含进行中/完成)。
    const isCreate = taskName === 'TaskCreate'
    if (isCreate) turn.taskUpdateI = null
    else turn.taskCreateI = null
    const isFirst = (isCreate ? turn.taskCreateI : turn.taskUpdateI) === null
    if (isFirst) {
      if (isCreate) turn.taskCreateI = turn.toolCount++
      else turn.taskUpdateI = turn.toolCount++
    }
    const ti = (isCreate ? turn.taskCreateI : turn.taskUpdateI) as number
    turn.toolByUseId.set(toolUseId, { i: ti, name, input })
    const el = cards.taskBoardElement(ti, s.taskBoard, { name: taskName, status: '⏳' })
    void (isFirst
      ? cardkit.addElement(turn.cardId, el, { type: 'insert_before', targetElementId: taskLiveAnchor(turn) })
      : cardkit.replaceElement(turn.cardId, cards.ELEMENTS.tool(ti), el))
    return
  }
  // 非 Task 工具:Task 面板合并窗口关闭(创建/进度面板各自定稿)
  s.currentTurn.taskCreateI = null
  s.currentTurn.taskUpdateI = null
  const i = s.currentTurn.toolCount++
  if (name === 'Read') {
    // First Read of a run — render the batch panel (file-paths only,
    // never source). Subsequent Reads append into the same batch via
    // the openReadBatchI fast-path above.
    s.currentTurn.openReadBatchI = i
    const items = [{ toolUseId, input, output: null, isError: false }]
    s.currentTurn.readBatches.set(i, { items })
    s.currentTurn.toolByUseId.set(toolUseId, { i, name, input, readBatchSlot: 0 })
    const el = cards.readBatchElement(i, items)
    void cardkit.addElement(s.currentTurn.cardId, el, {
      type: 'insert_before', targetElementId: taskLiveAnchor(s.currentTurn),
    })
    return
  }
  s.currentTurn.toolByUseId.set(toolUseId, { i, name, input })
  // AskUserQuestion is a client-side tool — daemon renders the choice
  // UI in-line and supplies the tool_result itself once the user
  // clicks. Branch BEFORE the generic toolCallElement so we never
  // fall through to a JSON dump or, worse, get clobbered by the
  // permission flow (which would render 🔐 three-button buttons that
  // don't match the actual N options).
  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(input?.questions) ? input.questions as cards.AskQuestion[] : []
    const startIdx = questions.length > 0 ? 0 : undefined
    const answered = new Map<number, cards.AskAnswered>()
    s.pendingAsks.set(toolUseId, {
      questions,
      i,
      answers: {},
      answered,
      currentIdx: startIdx,
    })
    const el = cards.askUserQuestionElement(i, toolUseId, questions, '🤔', {
      currentIdx: startIdx,
      answered,
    })
    void cardkit.addElement(s.currentTurn.cardId, el, {
      type: 'insert_before',
      targetElementId: taskLiveAnchor(s.currentTurn),
    })
    // Phone push — user has to come back and answer before Codex can
    // continue. Set summary to the question text so the lock-screen
    // notification preview shows what the user needs to answer.
    if (s.currentTurn.userOpenId && s.currentTurn.messageId) {
      const turn = s.currentTurn
      const q0 = questions[0]?.question?.trim() ?? ''
      const truncated = q0.length > 40 ? q0.slice(0, 40) + '…' : q0
      const summary = questions.length > 1
        ? `❓ 待回答 ${questions.length} 题${truncated ? `: ${truncated}` : ''}`
        : truncated
          ? `❓ ${truncated}`
          : '❓ 等你回答问题'
      void (async () => {
        cardkit.cancelSummary(turn.cardId)
        await cardkit.patchSettings(turn.cardId, { config: { summary: { content: summary } } })
        await feishu.urgentApp(turn.messageId, [turn.userOpenId])
      })()
    }
    return
  }
  const el = cards.toolCallElement(i, name, input, null, '⏳')
  void cardkit.addElement(s.currentTurn.cardId, el, {
    type: 'insert_before',
    targetElementId: taskLiveAnchor(s.currentTurn),
  })
}

export function completeTool(s: Session, toolUseId: string, content: any, isError: boolean): void {
  if (!s.currentTurn) return
  const meta = s.currentTurn.toolByUseId.get(toolUseId)
  if (!meta) return
  const output = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => c?.text ?? JSON.stringify(c)).join('\n')
      : JSON.stringify(content)
  // Stash on the meta so rotation can rebuild unfinished or failed
  // panels after this result lands.
  meta.output = output
  meta.isError = isError
  const autoSendPath = autoSendPathFromToolResult(meta.name, output, isError)
  if (autoSendPath) s.sendOutboundPath(autoSendPath, meta.name)
  // AskUserQuestion already had its final panel painted by resolveAsk
  // (✅ + the chosen option marked, others dimmed). The tool_result
  // arriving here is just the SDK's synthesised echo — re-rendering
  // via toolCallElement would clobber the nice option-row layout
  // with a generic JSON dump. Bail out; the panel is done.
  if (meta.name === 'AskUserQuestion') {
    startThinkingIfNoToolsRunning(s)
    return
  }
  // Read batch path: update this row's status in the shared batch then
  // re-render via the path-only `readBatchElement`. We never fall back
  // to `toolCallElement` for Read — single or batched, the panel only
  // ever lists file paths, not contents.
  if (meta.name === 'Read' && meta.readBatchSlot != null) {
    const batch = s.currentTurn.readBatches.get(meta.i)
    if (batch) {
      const row = batch.items[meta.readBatchSlot]
      if (row) { row.output = output; row.isError = isError }
      const el = cards.readBatchElement(meta.i, batch.items)
      void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
    }
    startThinkingIfNoToolsRunning(s)
    return
  }
  // Task 工具走累积 board 路径(见 cards/task-board.ts):用当次 input/output
  // 累积进 session board,渲染整个任务板而非孤立单条。
  const taskName = cards.asTaskToolName(meta.name)
  if (taskName) {
    completeTaskTool(s, meta, taskName, meta.input, output, isError, meta.resolvedNote)
    return
  }
  const el = cards.toolCallElement(meta.i, meta.name, meta.input, output, isError ? '❌' : '✅', meta.resolvedNote)
  void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
  startThinkingIfNoToolsRunning(s)
}

/** Task 工具完成:用单次调用的 input/output 累积进 session board,再渲染整个
 * board(而非孤立的当次结果)。TaskCreate 抓 output 里的 id、TaskUpdate 按 id
 * 改 status、TaskList 全量替换、TaskGet 补全。出错时 ❌ 但不动 board(避免
 * 一次坏结果污染累积状态)。 */
function completeTaskTool(s: Session, meta: { i: number; name: string }, taskName: cards.TaskToolName, input: any, output: string, isError: boolean, resolvedNote?: string): void {
  if (!s.currentTurn) return
  if (!isError) {
    s.taskBoard = cards.applyTaskTool(s.taskBoard, taskName, input, output)
  }
  const el = cards.taskBoardElement(meta.i, s.taskBoard, { name: taskName, status: isError ? '❌' : '✅' }, resolvedNote)
  void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.tool(meta.i), el)
  // 实时任务总览区同步刷新:applyTaskTool 已把 board 更新到最新,这里 replace
  // 让总览跟上(isError 不动 board,总览维持上次有效态,不显示坏结果)。
  if (s.currentTurn.taskLiveInserted) {
    void cardkit.replaceElement(s.currentTurn.cardId, cards.ELEMENTS.taskBoardLive, cards.taskBoardLiveElement(s.taskBoard))
  }
  startThinkingIfNoToolsRunning(s)
}

function startThinkingIfNoToolsRunning(s: Session): void {
  const turn = s.currentTurn
  if (!turn) return
  for (const tool of turn.toolByUseId.values()) {
    if (tool.output == null) return
  }
  s.startThinkingFooter(turn)
}

/** 换卡时把"还在跑 / 在旧卡没渲染成功"的 tool 搬到新卡重建,让它们的
 * result 回来仍能在新卡更新、建失败的也补上显示。已完成且旧卡上活着的
 * tool 不搬 —— 旧卡留底,也避免把新卡瞬间塞满又触发连锁 rotate。
 *
 * Read 按约定切开:合并 batch 里每个还需搬的 item 各自独立成一个新 panel,
 * 不再维持 batch 合并。rotate 是异常路径,功能正确(result 不丢)优先于
 * 合并美观。
 *
 * 调用约定:在 startMidTurnRotate 的 swap 完成后调(turn.cardId 已是新卡,
 * toolByUseId / readBatches / toolCount 已 reset),传入 swap 前同步快照的
 * oldToolByUseId / oldBatches —— swap 把这俩换成了新空 Map,旧对象只在快照里。 */
export function rebuildToolsOnRotate(
  s: Session,
  oldCardId: string,
  newCardId: string,
  oldToolByUseId: TurnState['toolByUseId'],
  oldBatches: TurnState['readBatches'],
): void {
  const turn = s.currentTurn
  if (!turn) return
  // 实时任务总览区的重建在 startMidTurnRotate 里(swap 后、assistant 重建前)
  // 已先于本函数完成 —— 这里搬过来的 tool insert_before taskLiveAnchor(turn)
  // 时 live 区已在新卡就位。board 是 session 级累积快照,这里直接用。
  for (const [useId, meta] of oldToolByUseId) {
    const isRead = meta.readBatchSlot != null
    let input = meta.input
    let output: string | null
    let isError: boolean
    if (isRead) {
      const item = oldBatches.get(meta.i)?.items[meta.readBatchSlot!]
      if (!item) continue
      input = item.input
      output = item.output
      isError = item.isError
    } else {
      output = meta.output ?? null
      isError = meta.isError ?? false
    }
    const done = output != null
    const deadOnOld = cardkit.isDeadElement(oldCardId, cards.ELEMENTS.tool(meta.i))
    // 已完成且旧卡上活着 → 留在旧卡,不搬。
    if (done && !deadOnOld) continue
    if (isRead) {
      const ni = turn.toolCount++
      const item = { toolUseId: useId, input, output, isError }
      turn.readBatches.set(ni, { items: [item] })
      turn.toolByUseId.set(useId, { ...meta, i: ni, readBatchSlot: 0 })
      void cardkit.addElement(newCardId, cards.readBatchElement(ni, [item]), {
        type: 'insert_before', targetElementId: taskLiveAnchor(turn),
      })
      continue
    }
    // Task 工具:与新卡 addTool 一致,整个流程复用本 turn 同一面板(board 是
    // 累积快照,重复建多个相同面板无意义)。第一个 task 工具建槽,后续 replace。
    const rotatedTaskName = cards.asTaskToolName(meta.name)
    if (rotatedTaskName) {
      const isCreate = rotatedTaskName === 'TaskCreate'
      if (isCreate) turn.taskUpdateI = null
      else turn.taskCreateI = null
      const isFirst = (isCreate ? turn.taskCreateI : turn.taskUpdateI) === null
      if (isFirst) {
        if (isCreate) turn.taskCreateI = turn.toolCount++
        else turn.taskUpdateI = turn.toolCount++
      }
      const ti = (isCreate ? turn.taskCreateI : turn.taskUpdateI) as number
      turn.toolByUseId.set(useId, { ...meta, i: ti })
      const status: '⏳' | '✅' | '❌' = !done ? '⏳' : (isError ? '❌' : '✅')
      const el = cards.taskBoardElement(ti, s.taskBoard, { name: rotatedTaskName, status }, meta.resolvedNote)
      void (isFirst
        ? cardkit.addElement(newCardId, el, { type: 'insert_before', targetElementId: taskLiveAnchor(turn) })
        : cardkit.replaceElement(newCardId, cards.ELEMENTS.tool(ti), el))
      continue
    }
    const ni = turn.toolCount++
    turn.toolByUseId.set(useId, { ...meta, i: ni })
    const status: '⏳' | '✅' | '❌' = !done ? '⏳' : (isError ? '❌' : '✅')
    void cardkit.addElement(newCardId, cards.toolCallElement(ni, meta.name, meta.input, output, status, meta.resolvedNote), {
      type: 'insert_before', targetElementId: taskLiveAnchor(turn),
    })
  }
}
