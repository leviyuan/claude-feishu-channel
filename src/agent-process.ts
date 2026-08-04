import type { EventEmitter } from 'node:events'
import type {
  CanUseToolRequest,
  CodexModel,
  CodexReasoningEffort,
  CodexResultMeta,
  CodexUsage,
  ContextCompactedNotification,
  HookCallbackRequest,
  PlanDelta,
  ThreadGoal,
  TokenUsageUpdated,
  TurnPlanUpdated,
} from './codex-process'

export type AgentProvider = 'codex' | 'claude'
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort

export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const CLAUDE_EFFORT: ClaudeReasoningEffort = 'max'

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return typeof value === 'string' && CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)
}

export function providerFromModel(model: string | null | undefined): AgentProvider {
  return model?.startsWith('claude:') ? 'claude' : 'codex'
}

export function agentProviderLabel(provider: AgentProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

/** 主动 compact 时上下文不足、后端未触发压缩。这不是错误 —— 是"无需压缩"的正常
 *  情况,调用方(runCompactCommand)应显示 ⓘ 提示而非 ❌ 失败。claude 路由 /compact
 *  在 transcript 不足时返回 "Not enough messages to compact." 且不 emit compact_boundary,
 *  compactThread 据此抛出;codex 目前不发此错误。 */
export class NothingToCompactError extends Error {
  constructor(message = '上下文窗口充足，无需压缩') {
    super(message)
    this.name = 'NothingToCompactError'
  }
}

export interface AgentProcess extends EventEmitter {
  readonly provider: AgentProvider
  sessionId: string | null
  lastAssistantUuid: string | null
  lastModel: string | null
  lastEffort: AgentReasoningEffort | null
  lastUsage: CodexUsage | null
  lastTotalUsage: CodexUsage | null
  lastResult: CodexResultMeta
  lastContextWindow: number | null
  /** Claude 路径的当前上下文占用 = 输入侧 token(input + cache_read +
   * cache_creation,不含 output),直接取自 SDK modelUsage。Codex 路径不用,
   * 恒 null(继续走 lastUsage.total_tokens)。 */
  lastContextTokens: number | null

  sendInitialize(): void
  sendUserText(text: string, files?: string[]): void
  sendInterrupt(): void
  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
  sendHookResponse(requestId: string, output?: object): void
  isAlive(): boolean
  kill(timeoutMs?: number): Promise<void>

  listModels(): Promise<CodexModel[]>
  setModelSettings(model: string, effort: AgentReasoningEffort): Promise<void>
  setModel(model: string): Promise<void>
  compactThread(): Promise<void>
  injectThreadItems(items: any[]): Promise<void>
}

export type AgentProcessEventMap = {
  error: Error
  init: any
  turn_started: { turn_id?: string | null; thread_id?: string | null }
  token_usage: TokenUsageUpdated
  turn_plan_updated: TurnPlanUpdated
  plan_delta: PlanDelta
  context_compacted: ContextCompactedNotification
  rate_limits_updated: any
  thread_goal_updated: ThreadGoal
  thread_goal_cleared: any
  assistant_text: { uuid?: string; text: string }
  assistant_block_stop: { index?: string }
  tool_use: { id: string; name: string; input: any }
  tool_result: { tool_use_id: string; content: any; is_error: boolean }
  can_use_tool: CanUseToolRequest
  hook_callback: HookCallbackRequest
  result: any
  exit: { code: number | null; signal: string | null; expected: boolean }
}
