/**
 * Schema 2.0 Feishu card templates — barrel re-export. Each call site
 * uses `import * as cards from './cards'` and reaches everything through
 * this file. Internal split so each module stays under practical
 * per-read token budget:
 *   - cards/elements.ts — ELEMENTS (shared element-id helpers)
 *   - cards/turn.ts     — main turn card, plan/goal/context/ask panels
 *   - cards/tool.ts     — tool summaries, tool panels, permission panels
 *   - cards/console.ts  — console + menu cards, formatters,
 *                          streamingOffSettings
 */

export { ELEMENTS, sanitizeMarkdownForCardKit } from './cards/elements'
export {
  type ThreadGoal,
  type TurnPlanStep,
  type ContextCompactionNotice,
  type AskQuestion,
  type AskAnswered,
  type AskState,
  footerContextPercentLabel,
  footerTokenDetailLine,
  mainConversationCard,
  assistantSegmentElement,
  contextCompactionElement,
  goalDisplaySignature,
  goalElement,
  planElement,
  planLiveElement,
  askUserQuestionElement,
} from './cards/turn'
export {
  displayToolName,
  summarizeToolInput,
  toolCallElement,
  readBatchElement,
  editBatchElement,
  toolCallPermissionElement,
} from './cards/tool'
export {
  type ConsoleOpts,
  type ModelEffortChoice,
  type ModelChoice,
  type ProviderChoice,
  consoleUsageContent,
  consoleUsageElement,
  consoleCurrentModelElement,
  consoleMainElement,
  consoleHostElement,
  consoleBodyElements,
  consoleCard,
  providerSelectionCard,
  modelSelectionCard,
  modelSelectionPanelElement,
  modelEffortSelectionCard,
  modelEffortSelectionPanelElement,
  modelResultCard,
  modelResultPanelElement,
  modelCancelledCard,
  modelCustomPromptCard,
  modelCustomResultCard,
  modelCustomResultPanelElement,
  statusCard,
  statusCardContent,
  menuCard,
  streamingOffSettings,
  fmtResetIn,
} from './cards/console'
export {
  type WorktreeCardEntry,
  type WorktreeListCardOpts,
  type WorktreeListNotice,
  type WorktreeNoticeCardOpts,
  worktreeListCard,
  worktreeNoticeCard,
} from './cards/worktree'
export {
  type TurnListEntry,
  type TurnListCardOpts,
  type ResumeListEntry,
  type ResumeListCardOpts,
  type WriteLogEntry,
  type WriteLogCardOpts,
  type SelectionResultCardOpts,
  turnListCard,
  resumeListCard,
  writeLogCard,
  selectionResultCard,
  writeBodyFromToolInput,
} from './cards/temp'
export {
  type AgyGitSnapshot,
  type AgyStats,
  type AgyTaskCardOpts,
  agyForwardElement,
  agyForwardPlaceholderElement,
  agyPromptElement,
  agyRepoElement,
  agyResultElement,
  agyStatsElement,
  agyTaskCard,
  cleanAgyOutputText,
} from './cards/agy'
export {
  type TasklistPanelNotice,
  type TasklistPanelOpts,
  tasklistPanelCard,
} from './cards/task'
export {
  type TaskBoardEntry,
  type TaskBoardOp,
  type TaskToolName,
  asTaskToolName,
  applyTaskTool,
  summarizeTaskBoard,
  taskBoardElement,
  taskBoardLiveElement,
} from './cards/task-board'
export {
  type BgTaskEntry,
  type BgTaskStep,
  type BgTaskType,
  type BgStore,
  BG_ELEMENTS,
  emptyBgStore,
  applyBgTaskStarted,
  applyBgTaskProgress,
  applyBgTaskUpdated,
  promotePendingOnAdvance,
  applyBgTaskSettled,
  applyBgToolUse,
  applyBgToolResult,
  applySubagentStep,
  isBgTerminal,
  hasActiveBgTask,
  summarizeBackground,
  backgroundLiveSummary,
  backgroundTaskPanel,
  backgroundLiveCard,
  backgroundHistoryCard,
  backgroundMigratedMarker,
  elapsedBucket,
  liveElapsed,
  LIVE_ELAPSED_SECOND_FOOTER_TICK_MS,
  type LiveElapsedMode,
} from './cards/background'
