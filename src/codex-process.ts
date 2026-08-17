/**
 * Headless Codex app-server subprocess + JSON-RPC control protocol.
 *
 * Spawned with:
 *   codex app-server --listen stdio://
 *
 * Stdin/stdout are line-delimited JSON-RPC-ish messages. Client requests
 * carry `{ id, method, params }`; server responses carry `{ id, result }`
 * or `{ id, error }`; notifications carry `{ method, params }`; server
 * requests carry `{ id, method, params }` and expect a client response.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { config } from './config'
import { log } from './log'
import {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  logContextCompactionPayload,
  logUnhandledAppServerPayload,
} from './codex-compaction'
import { diffUsageTotals, effectiveTurnTokens, usageFromTokenUsagePayload } from './codex-usage'
import type { AgentReasoningEffort } from './agent-process'

export function resolveCodexBin(): string {
  if (process.platform !== 'win32') {
    const pinned = join(homedir(), '.local', 'npm-global', 'bin', 'codex')
    if (existsSync(pinned)) return pinned
    const local = join(homedir(), '.local', 'bin', 'codex')
    if (existsSync(local)) return local
  }
  return whichCodex() ?? 'codex'
}

function whichCodex(): string | null {
  const PATH = process.env.PATH ?? ''
  if (!PATH) return null
  const candidates = process.platform === 'win32'
    ? ['codex.cmd', 'codex.bat', 'codex.exe', 'codex']
    : ['codex']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const name of candidates) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

function buildSpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].join(delimiter)
}

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
const CODEX_GENERATED_IMAGES_DIR = join(homedir(), '.codex', 'generated_images')

export interface SpawnOpts {
  workDir: string
  resumeSessionId?: string
  model?: string
  effort?: CodexReasoningEffort
  appendSystemPrompt?: string
  /** token source 注入:对 spawn env 做 scrub+inject(防 A 账号夹带 B 凭据)。未传 = 走 config 默认。 */
  transformEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  /** 该进程 spawn 时绑定的 token source id;stopIdleMismatchedProcess 据此判跨 source 重启。 */
  tokenSourceId?: string | null
}

export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort
  description: string
}
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CODEX_EFFORT: CodexReasoningEffort = 'xhigh'

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
}

export interface CanUseToolRequest {
  request_id: string
  tool_name: string
  input: any
  permission_suggestions?: any
  blocked_paths?: string[]
  tool_use_id?: string
}

export interface HookCallbackRequest {
  request_id: string
  callback_id: string
  input: any
  tool_use_id?: string
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed' | string
}

export interface TurnPlanUpdated {
  threadId?: string
  turnId?: string
  explanation: string | null
  plan: TurnPlanStep[]
}

export interface PlanDelta {
  threadId?: string
  turnId?: string
  itemId: string
  delta: string
}

export interface ContextCompactedNotification {
  threadId?: string
  turnId?: string
  itemId?: string
  sessionId?: string
  phase?: 'start' | 'end' | 'event'
  sourceMethod?: string
  sourceType?: string
  [key: string]: unknown
}

export interface ThreadGoal {
  threadId?: string
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete' | string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface CodexUsage {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface TokenUsageUpdated {
  usage: CodexUsage | null
  totalUsage: CodexUsage | null
  contextWindow: number | null
  threadId?: string
  turnId?: string
}

export interface CodexResultMeta {
  cost_usd: number | null
  cost_delta_usd: number | null
  duration_ms: number | null
  num_turns: number | null
  usage: CodexUsage | null
  subtype: string | null
  is_error: boolean
}

export {
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
} from './codex-compaction'
export { diffUsageTotals, effectiveTurnTokens, usageFromTokenUsagePayload } from './codex-usage'

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: CodexReasoningEffortOption[]
  defaultReasoningEffort: CodexReasoningEffort | null
}

function parseReasoningEffortOptions(raw: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<CodexReasoningEffort>()
  const options: CodexReasoningEffortOption[] = []
  for (const item of raw) {
    const effort = typeof item === 'string'
      ? item
      : typeof item === 'object' && item
        ? (item as { reasoningEffort?: unknown }).reasoningEffort
        : null
    if (!isCodexReasoningEffort(effort) || seen.has(effort)) continue
    seen.add(effort)
    const description = typeof item === 'object' && item && typeof (item as { description?: unknown }).description === 'string'
      ? (item as { description: string }).description
      : ''
    options.push({ reasoningEffort: effort, description })
  }
  return options
}

type PendingRequest = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
}

type ServerRequestState = {
  id: string | number
  method: string
  params: any
}

export class CodexProcess extends EventEmitter {
  readonly provider = 'codex' as const
  readonly tokenSourceId: string | null
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private stdoutBuf = ''
  private stderrBuf = ''
  private requestCounter = 0
  private pending = new Map<string | number, PendingRequest>()
  private serverRequests = new Map<string | number, ServerRequestState>()
  private alive = true
  private expectedExit = false
  private opts: SpawnOpts
  private readyPromise: Promise<void> | null = null
  private catalogInitPromise: Promise<void> | null = null
  private currentTurnId: string | null = null
  private rolloutFilePath: string | null = null
  private rolloutReadOffset = 0
  private emittedImageGenerationIds = new Set<string>()

  sessionId: string | null = null
  lastAssistantUuid: string | null = null
  lastModel: string | null = null
  lastEffort: CodexReasoningEffort | null = null
  lastUsage: CodexUsage | null = null
  lastTotalUsage: CodexUsage | null = null
  lastResult: CodexResultMeta = {
    cost_usd: null, cost_delta_usd: null, duration_ms: null, num_turns: null,
    usage: null, subtype: null, is_error: false,
  }
  lastContextWindow: number | null = null
  lastContextTokens: number | null = null

  constructor(opts: SpawnOpts) {
    super()
    // EventEmitter treats unhandled `error` specially. We still expose it
    // for Session logging, but a direct utility script should not
    // crash before it can surface the app-server failure.
    this.on('error', () => {})
    this.opts = opts
    this.tokenSourceId = opts.tokenSourceId ?? null
    const codexBin = resolveCodexBin()
    const args = ['app-server', '--listen', 'stdio://']
    log(`codex-process: spawn ${codexBin} app-server (cwd=${opts.workDir})`)
    const baseEnv = {
      ...(process.env as Record<string, string>),
      NPM_CONFIG_LOGLEVEL: 'error',
      PATH: buildSpawnPath(),
      ...config.codex.env,
    }
    this.proc = spawn(codexBin, args, {
      cwd: opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: opts.transformEnv ? opts.transformEnv(baseEnv) : baseEnv,
    }) as ChildProcessByStdio<Writable, Readable, Readable>

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    this.proc.on('exit', (code, signal) => {
      this.alive = false
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`codex app-server exited before ${pending.method} response (id=${id})`))
      }
      this.pending.clear()
      log(`codex-process: exited code=${code} signal=${signal} expected=${this.expectedExit}`)
      this.emit('exit', { code, signal, expected: this.expectedExit })
    })
    this.proc.on('error', err => {
      log(`codex-process: spawn error: ${err}`)
      this.emit('error', err)
    })
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        this.handleMessage(JSON.parse(line))
      } catch (e) {
        log(`codex-process: bad json: ${line.slice(0, 200)} (${e})`)
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuf += chunk.toString()
    let nl: number
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      if (line.trim()) log(`codex-process[stderr]: ${line}`)
    }
  }

  private handleMessage(msg: any): void {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) {
        log(`codex-process: response for unknown id=${msg.id}`)
        return
      }
      this.pending.delete(msg.id)
      if (msg.error) {
        pending.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
      this.handleServerRequest(msg)
      return
    }

    if (msg.method) {
      this.handleNotification(msg.method, msg.params ?? {})
      return
    }

    const compaction = contextCompactionNoticeFromMessage(msg)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(compaction.sourceMethod ?? 'raw_message', msg, notice)
      this.emit('context_compacted', notice)
      return
    }

    logUnhandledAppServerPayload('RAW_MESSAGE', msg)
    this.emit('raw', msg)
  }

  private handleNotification(method: string, params: any): void {
    const compaction = contextCompactionNoticeFromNotification(method, params)
    if (compaction) {
      const notice = this.withSessionId(compaction)
      logContextCompactionPayload(method, params, notice)
      this.emit('context_compacted', notice)
      return
    }
    switch (method) {
      case 'thread/started': {
        const thread = params.thread
        if (thread?.id) this.sessionId = thread.id
        return
      }
      case 'thread/settings/updated': {
        const settings = params.threadSettings
        if (typeof settings?.model === 'string') this.lastModel = settings.model
        if (isCodexReasoningEffort(settings?.effort)) this.lastEffort = settings.effort
        return
      }
      case 'thread/tokenUsage/updated': {
        // `last` is the latest model request and therefore the current
        // context-window footprint. `total` is cumulative across requests
        // in the thread and must not drive context-window percentages.
        const last = usageFromTokenUsagePayload(params.tokenUsage?.last)
        if (last) {
          this.lastUsage = last
          this.lastResult.usage = this.lastUsage
        } else {
          log('codex-process: tokenUsage notification missing last breakdown')
        }
        this.lastTotalUsage = usageFromTokenUsagePayload(params.tokenUsage?.total)
        const ctx = params.tokenUsage?.modelContextWindow
        if (typeof ctx === 'number' && ctx > 0) this.lastContextWindow = ctx
        this.emit('token_usage', {
          usage: this.lastUsage,
          totalUsage: this.lastTotalUsage,
          contextWindow: this.lastContextWindow,
          threadId: params.threadId,
          turnId: params.turnId,
        } as TokenUsageUpdated)
        return
      }
      case 'turn/started': {
        this.currentTurnId = params.turn?.id ?? null
        this.emit('turn_started', {
          turn_id: this.currentTurnId,
          thread_id: params.threadId ?? this.sessionId,
        })
        return
      }
      case 'turn/completed': {
        this.flushRolloutImageGenerations()
        const turn = params.turn ?? {}
        const status = turn.status
        const isError = status === 'failed' || !!turn.error
        const subtype = isError ? (turn.error?.type ?? turn.error?.message ?? 'failed') : 'success'
        this.lastResult = {
          cost_usd: null,
          cost_delta_usd: null,
          duration_ms: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          num_turns: 1,
          usage: this.lastUsage,
          subtype,
          is_error: isError,
        }
        this.currentTurnId = null
        this.emit('result', { subtype, is_error: isError, duration_ms: this.lastResult.duration_ms, usage: this.lastUsage })
        return
      }
      case 'turn/plan/updated': {
        this.emit('turn_plan_updated', params as TurnPlanUpdated)
        return
      }
      case 'item/plan/delta': {
        this.emit('plan_delta', params as PlanDelta)
        return
      }
      case 'thread/goal/updated': {
        if (params.goal) {
          this.emit('thread_goal_updated', params.goal as ThreadGoal)
        } else {
          log('codex-process: thread/goal/updated missing goal')
        }
        return
      }
      case 'thread/goal/cleared': {
        this.emit('thread_goal_cleared', params)
        return
      }
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          this.emit('assistant_text', { uuid: params.itemId, text: params.delta })
        } else {
          logUnhandledAppServerPayload('AGENT_MESSAGE_DELTA_EMPTY', { method, params })
        }
        return
      }
      case 'item/started': {
        this.handleItemStarted(params)
        return
      }
      case 'item/completed': {
        this.handleItemCompleted(params)
        return
      }
      case 'mcpServer/startupStatus/updated': {
        log(`codex-process: mcp ${params.name} ${params.status}${params.error ? `: ${params.error}` : ''}`)
        return
      }
      case 'account/rateLimits/updated': {
        this.emit('rate_limits_updated', params.rateLimits)
        return
      }
      case 'configWarning':
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice': {
        log(`codex-process: ${method}: ${params.summary ?? params.message ?? JSON.stringify(params).slice(0, 200)}`)
        return
      }
      case 'error': {
        log(`codex-process: server error: ${JSON.stringify(params).slice(0, 500)}`)
        this.emit('error', new Error(params.message ?? params.summary ?? 'codex app-server error'))
        return
      }
    }
    logUnhandledAppServerPayload('NOTIFICATION', { method, params })
    this.emit('raw', { method, params })
  }

  private handleItemStarted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_STARTED_MISSING_ID', { method: 'item/started', params })
      return
    }
    const mapped = mapStartedItem(item, this.opts.workDir)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_STARTED_UNMAPPED', { method: 'item/started', params })
      return
    }
    this.emit('tool_use', { id: item.id, name: mapped.name, input: mapped.input })
  }

  private handleItemCompleted(params: any): void {
    const item = params?.item
    if (!item?.id) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_MISSING_ID', { method: 'item/completed', params })
      return
    }
    if (item.type === 'agentMessage') {
      this.lastAssistantUuid = item.id
      this.emit('assistant_block_stop', { index: item.id })
      return
    }
    const mapped = mapCompletedItem(item, this.sessionId ?? undefined)
    if (!mapped) {
      logUnhandledAppServerPayload('ITEM_COMPLETED_UNMAPPED', { method: 'item/completed', params })
      return
    }
    this.emit('tool_result', {
      tool_use_id: item.id,
      content: mapped.output,
      is_error: mapped.isError,
    })
    if (item.type === 'imageGeneration') this.emittedImageGenerationIds.add(item.id)
  }

  private primeRolloutImageGenerationScan(): void {
    this.rolloutFilePath = null
    this.rolloutReadOffset = 0
    this.emittedImageGenerationIds.clear()
    if (!this.sessionId) return
    const filePath = findCodexRolloutFile(this.sessionId)
    if (!filePath) return
    this.rolloutFilePath = filePath
    try {
      this.rolloutReadOffset = statSync(filePath).size
      log(`codex-process: image generation rollout scan primed ${filePath} offset=${this.rolloutReadOffset}`)
    } catch (e) {
      log(`codex-process: image generation rollout stat failed ${filePath}: ${e instanceof Error ? e.message : e}`)
      this.rolloutFilePath = null
      this.rolloutReadOffset = 0
    }
  }

  private flushRolloutImageGenerations(): void {
    if (!this.sessionId) return
    const filePath = this.rolloutFilePath ?? findCodexRolloutFile(this.sessionId)
    if (!filePath) {
      log(`codex-process: image generation rollout file not found for thread=${this.sessionId}`)
      return
    }
    this.rolloutFilePath = filePath
    let buf: Buffer
    try {
      const size = statSync(filePath).size
      if (size <= this.rolloutReadOffset) return
      buf = readFileSync(filePath).subarray(this.rolloutReadOffset, size)
      this.rolloutReadOffset = size
    } catch (e) {
      log(`codex-process: image generation rollout read failed ${filePath}: ${e instanceof Error ? e.message : e}`)
      return
    }

    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let record: any
      try {
        record = JSON.parse(line)
      } catch (e) {
        log(`codex-process: image generation rollout JSON parse failed ${filePath}: ${e instanceof Error ? e.message : e}`)
        continue
      }
      const payload = record?.payload
      const type = payload?.type
      if (type !== 'image_generation_end' && type !== 'image_generation_call') continue
      this.emitRolloutImageGeneration(payload)
    }
  }

  private emitRolloutImageGeneration(payload: any): void {
    const callId = typeof payload?.call_id === 'string'
      ? payload.call_id
      : typeof payload?.id === 'string'
        ? payload.id
        : ''
    if (!callId || this.emittedImageGenerationIds.has(callId)) return
    const output = imageGenerationOutput(payload, this.sessionId ?? undefined)
    if (!output) return
    const isError = payload?.status === 'failed'
    const status = payload?.status === 'generating' && isAbsolute(output) ? 'completed' : payload?.status
    this.emittedImageGenerationIds.add(callId)
    this.emit('tool_use', {
      id: callId,
      name: 'ImageGeneration',
      input: {
        status,
        revisedPrompt: imageGenerationRevisedPrompt(payload),
      },
    })
    this.emit('tool_result', {
      tool_use_id: callId,
      content: output,
      is_error: isError,
    })
  }

  private withSessionId(notice: ContextCompactedNotification): ContextCompactedNotification {
    const sessionId = notice.sessionId ?? this.sessionId ?? undefined
    return sessionId ? { ...notice, sessionId } : notice
  }

  private handleServerRequest(req: any): void {
    const requestId = String(req.id)
    this.serverRequests.set(requestId, { id: req.id, method: req.method, params: req.params })
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'Bash',
          input: { command: p.command, cwd: p.cwd, reason: p.reason },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/fileChange/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'FileChange',
          input: { reason: p.reason, grantRoot: p.grantRoot },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/requestUserInput': {
        const p = req.params ?? {}
        const input = {
          questions: (p.questions ?? []).map((q: any) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: Array.isArray(q.options) && q.options.length
              ? q.options.map((o: any) => ({ label: o.label, description: o.description }))
              : [{ label: '自定义回答', description: q.isSecret ? '请直接在群里回复' : '可直接在群里回复' }],
          })),
        }
        this.emit('tool_use', { id: p.itemId, name: 'AskUserQuestion', input })
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'AskUserQuestion',
          input,
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/permissions/requestApproval': {
        const p = req.params ?? {}
        this.emit('can_use_tool', {
          request_id: requestId,
          tool_name: 'PermissionProfile',
          input: { cwd: p.cwd, reason: p.reason, permissions: p.permissions },
          tool_use_id: p.itemId,
        } as CanUseToolRequest)
        return
      }
      case 'item/tool/call': {
        const p = req.params ?? {}
        this.emit('tool_use', {
          id: p.callId,
          name: p.namespace ? `${p.namespace}.${p.tool}` : p.tool,
          input: p.arguments,
        })
        this.respond(requestId, { contentItems: [{ type: 'inputText', text: 'Lodestar does not implement this dynamic tool.' }], success: false })
        return
      }
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
      case 'applyPatchApproval':
      case 'execCommandApproval':
      default: {
        logUnhandledAppServerPayload('SERVER_REQUEST_UNSUPPORTED', req)
        this.respondError(requestId, `unsupported server request: ${req.method}`)
      }
    }
  }

  private write(obj: object): void {
    if (!this.alive) {
      log(`codex-process: write to dead process: ${JSON.stringify(obj).slice(0, 200)}`)
      return
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      log(`codex-process: stdin write failed: ${e}`)
    }
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.requestCounter
    this.write({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
  }

  private respond(id: string | number, result: any): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    this.write({ id: req?.id ?? id, result })
  }

  private respondError(id: string | number, message: string): void {
    const key = String(id)
    const req = this.serverRequests.get(key)
    this.serverRequests.delete(key)
    // code 必填:app-server 的 JSONRPCMessage 反序列化只认带 code 的 error
    // 对象,只回 {message} 会 deserialize 失败、request 永久悬挂(2026-08-17
    // 探针实测)。-32601 MethodNotFound 语义最接近"host 拒绝/不支持"。
    this.write({ id: req?.id ?? id, error: { code: -32601, message } })
  }

  sendInitialize(): void {
    if (!this.readyPromise) {
      const ready = this.initializeAndStartThread()
      ready.catch(e => {
        log(`codex-process: initialize failed: ${e}`)
        this.emit('error', e)
      })
      this.readyPromise = ready
    }
  }

  private initializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'lodestar', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
  }

  private async ensureCatalogReady(): Promise<void> {
    if (this.readyPromise) {
      await this.readyPromise
      return
    }
    if (!this.catalogInitPromise) {
      this.catalogInitPromise = this.request('initialize', this.initializeParams()).then(() => {})
    }
    await this.catalogInitPromise
  }

  private async initializeAndStartThread(): Promise<void> {
    await this.request('initialize', this.initializeParams())

    const params = this.threadParams()
    const res = this.opts.resumeSessionId
      ? await this.request('thread/resume', {
          threadId: this.opts.resumeSessionId,
          ...params,
          excludeTurns: true,
          persistExtendedHistory: false,
        })
      : await this.request('thread/start', {
          ...params,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })
    const thread = res?.thread
    this.sessionId = thread?.id ?? this.opts.resumeSessionId ?? null
    if (res?.model) this.lastModel = res.model
    if (isCodexReasoningEffort(res?.reasoningEffort)) this.lastEffort = res.reasoningEffort
    else this.lastEffort = this.opts.effort ?? null
    log(`codex-process: thread=${this.sessionId}`)
    this.primeRolloutImageGenerationScan()
    this.emit('init', { session_id: this.sessionId, thread })
  }

  private threadParams(): Record<string, unknown> {
    // model/effort 由 token source 决定、经 opts 下发(取代自治 ~/.codex/config.toml)。
    // opts 为空(无 token source,如旧路径)则不下发,走 codex 原生配置 —— 平滑过渡。
    // request_user_input 工具默认只在 Plan mode 注册;开 flag 让 Default mode 也能用,
    // 澄清问题走原生阻塞式工具调用(2026-08-17 探针验证全链路)。answer 回包格式见
    // sendPermissionResponse 的 item/tool/requestUserInput 分支。
    return {
      cwd: this.opts.workDir,
      runtimeWorkspaceRoots: [this.opts.workDir],
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { 'features.default_mode_request_user_input': true },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      ...(this.opts.appendSystemPrompt ? { developerInstructions: this.opts.appendSystemPrompt } : {}),
      serviceName: 'lodestar',
    }
  }

  sendUserText(text: string, files: string[] = []): void {
    const fileHints = files.length ? files.map(f => `[file: ${f}]`).join(' ') + '\n\n' : ''
    void this.startTurn(fileHints + text).catch(e => this.failTurnStart(e))
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureCatalogReady()
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const res = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      })
      if (!Array.isArray(res?.data)) {
        throw new Error('model/list returned no data array')
      }
      for (const raw of res.data) {
        if (typeof raw?.model !== 'string' || !raw.model) continue
        models.push({
          id: typeof raw.id === 'string' && raw.id ? raw.id : raw.model,
          model: raw.model,
          displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : raw.model,
          description: typeof raw.description === 'string' ? raw.description : '',
          hidden: raw.hidden === true,
          isDefault: raw.isDefault === true,
          supportedReasoningEfforts: parseReasoningEffortOptions(raw.supportedReasoningEfforts),
          defaultReasoningEffort: isCodexReasoningEffort(raw.defaultReasoningEffort)
            ? raw.defaultReasoningEffort
            : null,
        })
      }
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
    } while (cursor)
    return models
  }

  async injectThreadItems(items: any[]): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return
    if (!this.readyPromise) this.sendInitialize()
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('thread/inject_items', {
      threadId: this.sessionId,
      items,
    })
  }

  async setModelSettings(_model: string, _effort: AgentReasoningEffort): Promise<void> {
    // codex 后端走 ~/.codex/config.toml:model / effort 由 codex 决定,lodestar 不下发
    // thread/settings/update。保留方法签名以满足 AgentProcess 接口(session-model 切换时仍会调用)。
    log('codex-process: setModelSettings no-op (codex model/effort governed by ~/.codex/config.toml)')
  }

  async setModel(_model: string): Promise<void> {
    // codex 走配置:setModel/setModelSettings 均 no-op(model 由 ~/.codex/config.toml 决定)
    log('codex-process: setModel no-op (codex model governed by ~/.codex/config.toml)')
  }

  async compactThread(): Promise<void> {
    if (!this.readyPromise) throw new Error('codex thread not initialized')
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('thread/compact/start', {
      threadId: this.sessionId,
    })
  }

  private failTurnStart(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    log(`codex-process: turn/start failed: ${message}`)
    this.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: null,
      num_turns: null,
      usage: this.lastUsage,
      subtype: 'codex_turn_start_failed',
      is_error: true,
    }
    this.currentTurnId = null
    this.emit('result', {
      subtype: this.lastResult.subtype,
      is_error: true,
      duration_ms: null,
      usage: this.lastUsage,
      error: message,
    })
  }

  private async startTurn(text: string): Promise<void> {
    if (!this.readyPromise) this.sendInitialize()
    await this.readyPromise
    if (!this.sessionId) throw new Error('codex thread not initialized')
    await this.request('turn/start', {
      threadId: this.sessionId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: this.opts.workDir,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  }

  sendInterrupt(): void {
    if (!this.sessionId || !this.currentTurnId) return
    void this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.currentTurnId })
      .catch(e => log(`codex-process: interrupt failed: ${e}`))
  }

  sendPermissionResponse(
    requestId: string | number,
    decision: 'allow' | 'deny',
    payload?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown; denyMessage?: string },
  ): void {
    const req = this.serverRequests.get(String(requestId))
    if (!req) {
      log(`codex-process: permission response for unknown request ${requestId}`)
      return
    }
    const allow = decision === 'allow'
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/fileChange/requestApproval':
        this.respond(requestId, { decision: allow ? 'accept' : 'decline' })
        return
      case 'item/permissions/requestApproval':
        if (allow) {
          this.respond(requestId, {
            permissions: req.params?.permissions ?? {},
            scope: 'session',
          })
        } else {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
        }
        return
      case 'item/tool/requestUserInput': {
        if (!allow) {
          this.respondError(requestId, payload?.denyMessage ?? 'denied by user')
          return
        }
        const answersByQuestion = (payload?.updatedInput?.answers ?? {}) as Record<string, string>
        const answers: Record<string, { answers: string[] }> = {}
        for (const q of req.params?.questions ?? []) {
          const value = answersByQuestion[q.question] ?? answersByQuestion[q.id]
          if (value !== undefined) answers[q.id] = { answers: [String(value)] }
        }
        this.respond(requestId, { answers })
        return
      }
      default:
        logUnhandledAppServerPayload('APPROVAL_RESPONSE_UNSUPPORTED', {
          requestId,
          method: req.method,
          params: req.params,
          decision,
          payload,
        })
        this.respondError(requestId, payload?.denyMessage ?? 'unsupported approval request')
    }
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    log('codex-process: sendToolResult ignored; Codex app-server server requests are answered via sendPermissionResponse')
  }

  sendHookResponse(requestId: string, output: object = {}): void {
    this.respond(requestId, output)
  }

  isAlive(): boolean { return this.alive }

  async kill(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return
    this.expectedExit = true
    log(`codex-process: SIGTERM (timeout=${timeoutMs}ms)`)
    try { this.proc.kill('SIGTERM') } catch {}
    const start = Date.now()
    while (this.alive && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (this.alive) {
      log('codex-process: SIGKILL (graceful timeout)')
      try { this.proc.kill('SIGKILL') } catch {}
    }
  }
}

function mapStartedItem(item: any, workDir: string): { name: string; input: any } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', input: { command: item.command, cwd: item.cwd, source: item.source } }
    case 'fileChange':
      return { name: 'FileChange', input: { changes: item.changes, status: item.status, cwd: workDir } }
    case 'mcpToolCall':
      return { name: 'MCP', input: { server: item.server, tool: item.tool, arguments: item.arguments } }
    case 'dynamicToolCall':
      return { name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, input: item.arguments }
    case 'webSearch':
      return { name: 'WebSearch', input: { query: item.query, action: item.action } }
    case 'imageGeneration':
      return { name: 'ImageGeneration', input: { status: item.status, revisedPrompt: imageGenerationRevisedPrompt(item) } }
    case 'collabAgentToolCall':
      return { name: 'Agent', input: { tool: item.tool, prompt: item.prompt, model: item.model } }
  }
  return null
}

function imageGenerationRevisedPrompt(item: any): string | undefined {
  const prompt = item?.revisedPrompt ?? item?.revised_prompt
  return typeof prompt === 'string' && prompt ? prompt : undefined
}

function findCodexRolloutFile(sessionId: string): string | null {
  if (!sessionId || !existsSync(CODEX_SESSIONS_DIR)) return null
  let best: { path: string; mtimeMs: number } | null = null
  const stack = [CODEX_SESSIONS_DIR]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      log(`codex-process: cannot scan Codex session dir ${dir}: ${e instanceof Error ? e.message : e}`)
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`${sessionId}.jsonl`)) continue
      try {
        const mtimeMs = statSync(path).mtimeMs
        if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
      } catch (e) {
        log(`codex-process: cannot stat Codex rollout ${path}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  return best?.path ?? null
}

export function imageGenerationOutput(
  item: any,
  threadId?: string,
  outputRoot = CODEX_GENERATED_IMAGES_DIR,
): string {
  const directPath = item?.savedPath ?? item?.saved_path
  if (typeof directPath === 'string' && directPath) return directPath

  const result = item?.result
  if (typeof result === 'string') {
    const materialized = materializeImageGenerationResult(item, threadId, outputRoot)
    if (materialized) return materialized
    if (result.length > 2048) {
      const id = imageGenerationCallId(item)
      log(`codex-process: image generation inline result could not be decoded id=${id} length=${result.length}`)
      return `Image generation returned ${result.length} chars of inline data, but Lodestar could not materialize it as an image file.`
    }
    return result
  }
  if (result && typeof result === 'object') {
    const resultPath = result.savedPath ?? result.saved_path ?? result.path
    if (typeof resultPath === 'string' && resultPath) return resultPath
    return JSON.stringify(result, null, 2)
  }
  return ''
}

function materializeImageGenerationResult(item: any, threadId: string | undefined, outputRoot: string): string | null {
  const result = item?.result
  if (typeof result !== 'string') return null
  const decoded = imageBufferFromBase64Result(result)
  if (!decoded) return null

  const threadPart = sanitizeGeneratedImagePart(threadId ?? 'unknown-thread')
  const callPart = sanitizeGeneratedImagePart(imageGenerationCallId(item))
  const dir = join(outputRoot, threadPart)
  const path = join(dir, `${callPart}.${decoded.ext}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, decoded.buffer)
    return path
  } catch (e) {
    log(`codex-process: failed to write image generation result ${path}: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

function imageGenerationCallId(item: any): string {
  const id = item?.callId ?? item?.call_id ?? item?.id
  return typeof id === 'string' && id ? id : `image-${Date.now()}`
}

function sanitizeGeneratedImagePart(part: string): string {
  const sanitized = part.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '')
  return sanitized ? sanitized.slice(0, 140) : 'unknown'
}

function imageBufferFromBase64Result(result: string): { buffer: Buffer; ext: string } | null {
  const trimmed = result.trim()
  let base64 = trimmed
  let hintedExt: string | null = null
  const dataUrl = trimmed.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s)
  if (dataUrl) {
    hintedExt = mimeSubtypeToExtension(dataUrl[1])
    base64 = dataUrl[2]
  } else {
    if (trimmed.length < 64) return null
    if (!/^[a-zA-Z0-9+/=_\-\s]+$/.test(trimmed)) return null
  }
  base64 = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!base64 || base64.length % 4 === 1) return null

  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let buffer: Buffer
  try {
    buffer = Buffer.from(padded, 'base64')
  } catch {
    return null
  }
  if (buffer.length < 12) return null

  const ext = detectImageExtension(buffer) ?? hintedExt
  if (!ext) return null
  return { buffer, ext }
}

function detectImageExtension(buffer: Buffer): string | null {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  const header = buffer.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

function mimeSubtypeToExtension(subtype: string): string | null {
  const normalized = subtype.toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'jpg'
  if (normalized === 'png') return 'png'
  if (normalized === 'gif') return 'gif'
  if (normalized === 'webp') return 'webp'
  return null
}

function mapCompletedItem(item: any, threadId?: string): { output: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        output: item.aggregatedOutput ?? '',
        isError: item.exitCode != null && item.exitCode !== 0,
      }
    case 'fileChange':
      return { output: JSON.stringify(item.changes ?? [], null, 2), isError: item.status === 'failed' }
    case 'mcpToolCall':
      return {
        output: item.error ? JSON.stringify(item.error, null, 2) : JSON.stringify(item.result ?? null, null, 2),
        isError: !!item.error,
      }
    case 'dynamicToolCall':
      return {
        output: JSON.stringify(item.contentItems ?? [], null, 2),
        isError: item.success === false,
      }
    case 'webSearch':
      return { output: JSON.stringify(item.action ?? {}, null, 2), isError: false }
    case 'imageGeneration':
      return { output: imageGenerationOutput(item, threadId), isError: item.status === 'failed' }
    case 'collabAgentToolCall':
      return { output: JSON.stringify(item.agentsStates ?? {}, null, 2), isError: item.status === 'failed' }
  }
  return null
}
