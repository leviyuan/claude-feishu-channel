import type { AgentProcess } from './agent-process'
import { isClaudeReasoningEffort } from './agent-process'
import { ClaudeAgentProcess } from './claude-agent-process'
import { CodexProcess, isCodexReasoningEffort } from './codex-process'
import type { ConsultIdentity } from './consult-identities'
import { getTokenSource } from './token-source'

const REVIEWER_TIMEOUT_MS = 30 * 60 * 1000
const MAX_REVIEWER_OUTPUT_CHARS = 200_000
const MAX_CONSULT_PROMPT_CHARS = 800_000
const CONSULT_ENV_KEYS = [
  'LODESTAR_CONSULT_URL',
  'LODESTAR_CONSULT_CAPABILITY',
  'LODESTAR_CONSULT_SESSION',
]

export interface ConsultWorkerResult {
  output: string
  durationMs: number
  usage: Record<string, number | undefined> | null
}

export interface ConsultWorkerHandle {
  done: Promise<ConsultWorkerResult>
  cancel(reason?: string): Promise<void>
}

export function startConsultWorker(opts: {
  identity: ConsultIdentity
  workDir: string
  prompt: string
}): ConsultWorkerHandle {
  const source = getTokenSource(opts.identity.tokenSourceId)
  if (!source) throw new Error(`consult token source not found: ${opts.identity.tokenSourceId}`)
  if (!source.enabled) throw new Error(`consult token source disabled: ${source.id}`)
  if (opts.identity.status !== 'ready') throw new Error(opts.identity.reason ?? `consult identity is ${opts.identity.status}`)
  if (opts.identity.spawnRevision && source.spawnRevision !== opts.identity.spawnRevision) {
    throw new Error(`consult token source changed after identity discovery: ${source.id}`)
  }
  const modelEntry = source.models.find(model => model.model === opts.identity.model)
  if (!modelEntry) throw new Error(`consult model disappeared after identity discovery: ${source.id}/${opts.identity.model}`)
  if (!modelEntry.efforts.includes(opts.identity.effort)) {
    throw new Error(`consult effort is no longer supported: ${source.id}/${opts.identity.model}/${opts.identity.effort}`)
  }
  const spawnModel = source.resolveSpawnModel(opts.identity.model)
  if (!spawnModel) throw new Error(`consult model did not resolve: ${source.id}/${opts.identity.model}`)
  const transformEnv = (base: Record<string, string | undefined>): Record<string, string | undefined> =>
    stripConsultCapabilityEnv(source.spawnEnv(base))
  const proc = createProcess(opts.identity, opts.workDir, spawnModel, transformEnv)
  return collectOneShot(proc, opts.prompt)
}

export function stripConsultCapabilityEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env }
  for (const key of CONSULT_ENV_KEYS) delete out[key]
  return out
}

function createProcess(
  identity: ConsultIdentity,
  workDir: string,
  model: string,
  transformEnv: (base: Record<string, string | undefined>) => Record<string, string | undefined>,
): AgentProcess {
  const systemPrompt = [
    '你是 Lodestar 启动的一次性独立顾问。',
    '只读取当前项目并分析；允许自由联网检索和访问外部资料。',
    '不得读取项目外文件、修改文件、执行有副作用的命令、向外部系统发送消息或调用 lodestar-consult。',
    '不要询问用户；证据不足时明确写出 MISS/待确认。',
  ].join('\n')
  if (identity.provider === 'codex') {
    if (!isCodexReasoningEffort(identity.effort)) throw new Error(`invalid Codex consult effort: ${identity.effort}`)
    return new CodexProcess({
      workDir,
      model,
      effort: identity.effort,
      appendSystemPrompt: systemPrompt,
      sandbox: 'read-only',
      networkAccess: true,
      ephemeral: true,
      configOverrides: codexConsultConfigOverrides(),
      disabledFeatures: ['apps', 'plugins', 'multi_agent'],
      tokenSourceId: identity.tokenSourceId,
      transformEnv,
    })
  }
  if (!isClaudeReasoningEffort(identity.effort)) throw new Error(`invalid Claude consult effort: ${identity.effort}`)
  return new ClaudeAgentProcess({
    workDir,
    model,
    effort: identity.effort,
    systemPrompt,
    safeMode: true,
    readOnlyRoots: [workDir],
    readOnlyExtraTools: ['WebSearch', 'WebFetch'],
    profile: {
      tools: 'Read,Grep,Glob,WebSearch,WebFetch',
      strictMcp: true,
      loadProjectMcp: false,
    },
    settingSources: sourceSettingSources(identity.tokenSourceId),
    tokenSourceId: identity.tokenSourceId,
    transformEnv,
  })
}

/** Linux Bubblewrap is blocked by AppArmor/user-namespace policy on common
 * daemon hosts (including Lodestar's production host). Codex's supported
 * Landlock backend preserves the read-only contract without ever
 * retrying unsandboxed. Other platforms use their native Codex sandbox. */
export function codexConsultConfigOverrides(platform: NodeJS.Platform = process.platform): string[] {
  return [
    'mcp_servers={}',
    'hooks={}',
    'web_search="live"',
    ...(platform === 'linux' ? ['features.use_legacy_landlock=true'] : []),
    'shell_environment_policy.include_only=["PATH","HOME","USER","LOGNAME","TMPDIR","TEMP","TMP","SHELL","COMSPEC","SYSTEMROOT","WINDIR","PATHEXT"]',
    'shell_environment_policy.ignore_default_excludes=false',
  ]
}

function sourceSettingSources(tokenSourceId: string): readonly string[] {
  return getTokenSource(tokenSourceId)?.settingSources ?? []
}

function collectOneShot(proc: AgentProcess, prompt: string): ConsultWorkerHandle {
  let output = ''
  let lastError: Error | null = null
  let settled = false
  let resolveDone!: (value: ConsultWorkerResult) => void
  let rejectDone!: (error: Error) => void
  const startedAt = Date.now()
  const done = new Promise<ConsultWorkerResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const cleanupListeners = () => {
    proc.off('assistant_text', onText)
    proc.off('can_use_tool', onPermission)
    proc.off('hook_callback', onHook)
    proc.off('error', onError)
    proc.off('result', onResult)
    proc.off('exit', onExit)
  }
  const finish = async (error?: Error): Promise<void> => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    cleanupListeners()
    let closeError: Error | null = null
    try { await proc.kill(3000) }
    catch (cause) { closeError = cause instanceof Error ? cause : new Error(String(cause)) }
    const failure = error ?? closeError
    if (failure) {
      rejectDone(failure)
      return
    }
    const text = output.trim()
    if (!text) {
      rejectDone(new Error('consult reviewer completed without assistant output'))
      return
    }
    resolveDone({
      output: text,
      durationMs: Date.now() - startedAt,
      usage: proc.lastUsage ? { ...proc.lastUsage } : null,
    })
  }
  const onText = (event: { text?: string }) => {
    if (typeof event?.text !== 'string') return
    output += event.text
    if (output.length > MAX_REVIEWER_OUTPUT_CHARS) {
      void finish(new Error(`consult reviewer output exceeds ${MAX_REVIEWER_OUTPUT_CHARS} chars`))
    }
  }
  const onPermission = (request: { request_id: string | number }) => {
    proc.sendPermissionResponse(request.request_id, 'deny', { denyMessage: '一次性顾问不接受交互或副作用工具' })
  }
  const onHook = (request: { request_id: string | number }) => proc.sendHookResponse(String(request.request_id), {})
  const onError = (error: unknown) => {
    lastError = error instanceof Error ? error : new Error(String(error))
  }
  const onResult = (result: { is_error?: boolean; error?: unknown; subtype?: unknown }) => {
    const error = result?.is_error
      ? new Error(String(result.error ?? result.subtype ?? proc.lastResult.subtype ?? 'consult reviewer failed'))
      : undefined
    void finish(error)
  }
  const onExit = (event: { code?: number | null; signal?: string | null; expected?: boolean }) => {
    if (settled) return
    const detail = `code=${event?.code ?? 'null'} signal=${event?.signal ?? 'null'}`
    void finish(lastError ?? new Error(`consult reviewer exited before result (${detail})`))
  }
  const timeout = setTimeout(() => {
    void finish(new Error(`consult reviewer timed out after ${REVIEWER_TIMEOUT_MS / 1000}s`))
  }, REVIEWER_TIMEOUT_MS)

  proc.on('assistant_text', onText)
  proc.on('can_use_tool', onPermission)
  proc.on('hook_callback', onHook)
  proc.on('error', onError)
  proc.on('result', onResult)
  proc.on('exit', onExit)
  try {
    proc.sendInitialize()
    proc.sendUserText(prompt)
  } catch (error) {
    void finish(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    done,
    async cancel(reason = 'consult cancelled'): Promise<void> {
      await finish(new Error(reason))
      await done.catch(() => {})
    },
  }
}

export function buildConsultPrompt(opts: {
  identity: ConsultIdentity
  kind: 'question' | 'review' | 'critique'
  question: string
  instructions: string
  targetContext: string
  peerOutputs?: Array<{ name: string; output: string }>
}): string {
  const task = opts.kind === 'question'
    ? '回答咨询问题'
    : opts.kind === 'critique'
      ? '批判性复核给定结论'
      : '执行独立评审'
  const sections = [
    `身份: ${opts.identity.displayName}`,
    `角色约束: ${opts.identity.instructions ?? ''}`,
    `角色重点: ${opts.identity.role}`,
    `任务: ${task}`,
    opts.question ? `问题:\n${opts.question}` : '',
    opts.instructions ? `额外要求:\n${opts.instructions}` : '',
    `目标上下文:\n${opts.targetContext}`,
  ]
  if (opts.peerOutputs?.length) {
    sections.push([
      '其他顾问首轮结果（仅供交叉复核）:',
      ...opts.peerOutputs.map((peer, index) => `\n--- 匿名顾问 ${index + 1} ---\n${peer.output}`),
      '\n逐条说明你同意、反驳或修正了哪些结论，并给出证据。',
    ].join('\n'))
  }
  sections.push([
    '输出要求:',
    '- 用 Markdown，先给结论。',
    '- review/critique 需按 blocker/high/medium/low 列出 findings，包含位置、证据和建议。',
    '- 没有发现时明确写“未发现具体问题”，不得伪造证据。',
    '- 不修改任何文件。',
  ].join('\n'))
  const prompt = sections.filter(Boolean).join('\n\n')
  if (prompt.length > MAX_CONSULT_PROMPT_CHARS) {
    throw new Error(`consult reviewer prompt exceeds ${MAX_CONSULT_PROMPT_CHARS} chars`)
  }
  return prompt
}
