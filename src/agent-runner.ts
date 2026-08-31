import type { AgentProcess, AgentReasoningEffort } from './agent-process'
import type { AgentIdentity } from './agent-identities'
import { createAgentProcess } from './agent-launch'
import { rememberAgentSession } from './agent-session-registry'
import type { AgentInputQuestion, AgentInputRequest, AgentStep } from './agent-run-types'
import type { ConversationLaunch } from './conversation'
import type { ProjectProfile } from './config'
import { getTokenSource } from './token-source'

const AGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000
const MAX_AGENT_OUTPUT_CHARS = 2_000_000

export interface AgentWorkerResult {
  output: string
  outputTruncated: boolean
  sessionId: string
  checkpointId?: string
  durationMs: number
  usage: Record<string, number | undefined> | null
}

export interface AgentWorkerCallbacks {
  onNeedsInput?(request: AgentInputRequest): void
  onProgress?(step: AgentStep): void
  onSession?(sessionId: string): void
}

export interface AgentWorkerHandle {
  done: Promise<AgentWorkerResult>
  pendingInput(): AgentInputRequest | null
  answer(requestId: string, answers: Record<string, string>): void
  cancel(reason?: string): Promise<void>
}

export function startAgentWorker(opts: {
  identity: AgentIdentity
  effort: AgentReasoningEffort
  workDir: string
  prompt: string
  resumeSessionId?: string
  developerInstructions?: string
  profile?: ProjectProfile
  managedSkillPluginPath?: string
  hostEnv: Record<string, string | undefined>
  callbacks?: AgentWorkerCallbacks
}): AgentWorkerHandle {
  const source = getTokenSource(opts.identity.tokenSourceId)
  if (!source) throw new Error(`agent token source not found: ${opts.identity.tokenSourceId}`)
  if (opts.identity.spawnRevision && source.spawnRevision !== opts.identity.spawnRevision) {
    throw new Error(`agent token source changed after identity discovery: ${source.id}`)
  }
  if (!opts.identity.supportedEfforts.includes(opts.effort)) {
    throw new Error(`${opts.identity.displayName} does not support effort ${opts.effort}`)
  }
  const launch: ConversationLaunch = opts.resumeSessionId
    ? { kind: 'resume', source: { provider: opts.identity.provider, sessionId: opts.resumeSessionId, cwd: opts.workDir } }
    : { kind: 'fresh' }
  const { process: proc } = createAgentProcess({
    provider: opts.identity.provider,
    workDir: opts.workDir,
    tokenSourceId: opts.identity.tokenSourceId,
    model: opts.identity.model,
    effort: opts.effort,
    launch,
    developerInstructions: opts.developerInstructions,
    profile: opts.profile,
    managedSkillPluginPath: opts.managedSkillPluginPath,
    hostEnv: opts.hostEnv,
    serviceName: 'lodestar-agent',
  })
  return collectAgentTurn(proc, opts.prompt, opts.callbacks)
}

export function collectAgentTurn(
  proc: AgentProcess,
  prompt: string,
  callbacks: AgentWorkerCallbacks = {},
  remember: typeof rememberAgentSession = rememberAgentSession,
): AgentWorkerHandle {
  let output = ''
  let outputTruncated = false
  let lastError: Error | null = null
  let settled = false
  let waiting: { request: AgentInputRequest; originalInput: Record<string, unknown> } | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveDone!: (value: AgentWorkerResult) => void
  let rejectDone!: (error: Error) => void
  const startedAt = Date.now()
  const done = new Promise<AgentWorkerResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const clearWatchdog = () => {
    if (timeout) clearTimeout(timeout)
    timeout = null
  }
  const armWatchdog = () => {
    clearWatchdog()
    timeout = setTimeout(() => {
      void finish(new Error(`delegated agent timed out after ${AGENT_TURN_TIMEOUT_MS / 1000}s`))
    }, AGENT_TURN_TIMEOUT_MS)
  }
  const rememberSession = (sessionId: string | null | undefined): Error | null => {
    if (!sessionId) return null
    try {
      remember(proc.provider, sessionId)
      callbacks.onSession?.(sessionId)
      return null
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }
  const cleanupListeners = () => {
    proc.off('assistant_text', onText)
    proc.off('tool_use', onToolUse)
    proc.off('tool_result', onToolResult)
    proc.off('subagent_step', onSubagentStep)
    proc.off('can_use_tool', onPermission)
    proc.off('hook_callback', onHook)
    proc.off('init', onInit)
    proc.off('error', onError)
    proc.off('result', onResult)
    proc.off('exit', onExit)
  }
  const finish = async (error?: Error, result?: { checkpoint?: any }): Promise<void> => {
    if (settled) return
    settled = true
    clearWatchdog()
    cleanupListeners()
    const registryError = rememberSession(proc.sessionId)
    let closeError: Error | null = null
    try { await proc.kill(3000) }
    catch (cause) { closeError = cause instanceof Error ? cause : new Error(String(cause)) }
    const failure = error ?? registryError ?? closeError
    if (failure) {
      rejectDone(failure)
      return
    }
    const sessionId = proc.sessionId
    if (!sessionId) {
      rejectDone(new Error('delegated agent completed without a native session id'))
      return
    }
    const text = output.trim()
    const checkpointId = checkpointIdFrom(result?.checkpoint, proc)
    resolveDone({
      output: outputTruncated ? `${text}\n\n[delegated agent output truncated at ${MAX_AGENT_OUTPUT_CHARS} chars]` : text,
      outputTruncated,
      sessionId,
      ...(checkpointId ? { checkpointId } : {}),
      durationMs: Date.now() - startedAt,
      usage: proc.lastUsage ? { ...proc.lastUsage } : null,
    })
  }
  const onText = (event: { text?: string; parentToolUseId?: string | null }) => {
    if (event?.parentToolUseId || typeof event?.text !== 'string' || outputTruncated) return
    const remaining = MAX_AGENT_OUTPUT_CHARS - output.length
    if (event.text.length > remaining) {
      output += event.text.slice(0, Math.max(0, remaining))
      outputTruncated = true
      return
    }
    output += event.text
  }
  const emitProgress = (step: AgentStep) => {
    try { callbacks.onProgress?.(step) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onToolUse = (event: { name?: string }) => emitProgress({
    at: new Date().toISOString(), phase: 'started', tool: String(event?.name ?? 'tool'), detail: '',
  })
  const onToolResult = (event: { is_error?: boolean }) => emitProgress({
    at: new Date().toISOString(), phase: 'completed', tool: event?.is_error ? 'tool error' : 'tool result', detail: '',
  })
  const onSubagentStep = (event: { tool?: string; phase?: 'started' | 'completed' }) => emitProgress({
    at: new Date().toISOString(), phase: event?.phase ?? 'info', tool: String(event?.tool ?? 'subagent'), detail: '',
  })
  const onPermission = (request: {
    request_id: string | number
    tool_name?: string
    tool_use_id?: string
    input?: Record<string, unknown>
  }) => {
    if (request.tool_name !== 'AskUserQuestion') {
      try { proc.sendPermissionResponse(request.request_id, 'allow', { updatedInput: request.input ?? {} }) }
      catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    if (waiting) {
      void finish(new Error('delegated agent emitted multiple simultaneous input requests'))
      return
    }
    let normalized: AgentInputRequest
    try { normalized = normalizeInputRequest(request) }
    catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)))
      return
    }
    waiting = { request: normalized, originalInput: request.input ?? {} }
    clearWatchdog()
    try { callbacks.onNeedsInput?.(normalized) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onHook = (request: { request_id: string | number }) => {
    try { proc.sendHookResponse(String(request.request_id), {}) }
    catch (error) { void finish(error instanceof Error ? error : new Error(String(error))) }
  }
  const onInit = (event: { session_id?: string }) => {
    const error = rememberSession(event?.session_id ?? proc.sessionId)
    if (error) void finish(error)
  }
  const onError = (error: unknown) => { lastError = error instanceof Error ? error : new Error(String(error)) }
  const onResult = (result: { is_error?: boolean; error?: unknown; subtype?: unknown; checkpoint?: unknown }) => {
    const error = result?.is_error
      ? new Error(String(result.error ?? result.subtype ?? proc.lastResult.subtype ?? 'delegated agent failed'))
      : undefined
    void finish(error, result)
  }
  const onExit = (event: { code?: number | null; signal?: string | null }) => {
    if (settled) return
    const detail = `code=${event?.code ?? 'null'} signal=${event?.signal ?? 'null'}`
    void finish(lastError ?? new Error(`delegated agent exited before result (${detail})`))
  }

  proc.on('assistant_text', onText)
  proc.on('tool_use', onToolUse)
  proc.on('tool_result', onToolResult)
  proc.on('subagent_step', onSubagentStep)
  proc.on('can_use_tool', onPermission)
  proc.on('hook_callback', onHook)
  proc.on('init', onInit)
  proc.on('error', onError)
  proc.on('result', onResult)
  proc.on('exit', onExit)
  armWatchdog()
  try {
    proc.sendInitialize()
    proc.sendUserText(prompt)
  } catch (error) {
    void finish(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    done,
    pendingInput: () => waiting?.request ?? null,
    answer(requestId: string, answers: Record<string, string>): void {
      if (!waiting) throw new Error('delegated agent is not waiting for input')
      if (waiting.request.requestId !== requestId) {
        throw new Error(`delegated agent input request mismatch: expected ${waiting.request.requestId}`)
      }
      const pending = waiting
      proc.sendPermissionResponse(requestId, 'allow', { updatedInput: { ...pending.originalInput, answers } })
      waiting = null
      armWatchdog()
    },
    async cancel(reason = 'delegated agent cancelled'): Promise<void> {
      await finish(new Error(reason))
      await done.catch(() => {})
    },
  }
}

function normalizeInputRequest(request: {
  request_id: string | number
  tool_use_id?: string
  input?: Record<string, unknown>
}): AgentInputRequest {
  const input = request.input ?? {}
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [input]
  const questions = rawQuestions.map((raw, index) => normalizeQuestion(raw, index))
  if (questions.length === 0) throw new Error('delegated agent input request contains no questions')
  return {
    requestId: String(request.request_id),
    ...(request.tool_use_id ? { toolUseId: request.tool_use_id } : {}),
    questions,
  }
}

function normalizeQuestion(raw: unknown, index: number): AgentInputQuestion {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { question: raw }
  const question = String(value.question ?? value.prompt ?? value.title ?? '').trim()
  if (!question) throw new Error(`delegated agent input question ${index + 1} is empty`)
  const id = String(value.id ?? question)
  const options = Array.isArray(value.options)
    ? value.options.map(option => {
        if (typeof option === 'string') return { label: option }
        const item = option && typeof option === 'object' ? option as Record<string, unknown> : {}
        return { label: String(item.label ?? item.value ?? ''), ...(item.description ? { description: String(item.description) } : {}) }
      }).filter(option => option.label)
    : []
  return { id, ...(value.header ? { header: String(value.header) } : {}), question, options }
}

function checkpointIdFrom(checkpoint: any, proc: AgentProcess): string | undefined {
  if (typeof checkpoint?.id === 'string' && checkpoint.id) return checkpoint.id
  if (proc.provider === 'codex' && typeof proc.lastCompletedTurnId === 'string' && proc.lastCompletedTurnId) return proc.lastCompletedTurnId
  if (proc.provider === 'claude' && proc.lastAssistantUuid) return proc.lastAssistantUuid
  return undefined
}
