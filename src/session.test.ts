import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  boundResumes, deletedReactions, projectProfiles, resetFeishuMock,
  sentCards, sentRawTexts, sentTexts, urgentPushes,
} from './feishu-test-mock'

const { Session } = await import('./session')
const cardkit = await import('./cardkit')
const { fixedModelChoices, normalizeFixedModelSelection } = await import('./session-model')
const { config } = await import('./config')
const { peekUsage, updateUsageFromRateLimits } = await import('./usage')

interface FetchCall {
  method: string
  path: string
  body: any
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

beforeEach(() => {
  calls = []
  resetFeishuMock()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/open-apis/cardkit/v1', '')
    calls.push({
      method: String(init?.method ?? 'GET'),
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const data = path === '/cards/id_convert'
      ? { card_id: `card_status_${calls.length}` }
      : {}
    return new Response(JSON.stringify({ code: 0, data }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

class FakeAgentProc extends EventEmitter {
  lastAssistantUuid = null
  lastModel = null
  lastEffort = null
  lastUsage = null
  lastTotalUsage = null
  lastResult = {
    cost_usd: null,
    cost_delta_usd: null,
    duration_ms: null,
    num_turns: null,
    usage: null,
    subtype: null,
    is_error: false,
  }
  lastContextWindow = null
  sentTexts: string[] = []
  killCalls = 0
  setModelSettingsCalls: Array<[string, string]> = []
  alive = true

  constructor(
    readonly provider: 'codex' | 'claude',
    public sessionId: string | null = null,
  ) {
    super()
  }

  sendInitialize(): void {}

  sendUserText(text: string): void {
    this.sentTexts.push(text)
  }

  sendInterrupt(): void {}
  sendPermissionResponse(): void {}
  sendToolResult(): void {}
  sendHookResponse(): void {}

  isAlive(): boolean {
    return this.alive
  }

  async kill(): Promise<void> {
    this.killCalls++
    this.alive = false
    this.emit('exit', { code: 0, signal: null, expected: true })
  }

  async listModels(): Promise<any[]> {
    return []
  }

  async setModelSettings(model: string, effort: string): Promise<void> {
    this.setModelSettingsCalls.push([model, effort])
  }
  async setModel(): Promise<void> {}
  async compactThread(): Promise<void> {}
  async injectThreadItems(): Promise<void> {}
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function turnState(cardId = 'card_session_turn'): any {
  return {
    cardId,
    messageId: 'om_session_turn',
    userOpenId: 'ou_user',
    trigger: 'user_message',
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
}

describe('Session fresh conversation state', () => {
  test('resets visible turn numbering and per-conversation counters', () => {
    const session = new Session('probe', 'chat_id') as any
    session.turnCounter = 7
    session.currentGoal = { objective: 'old goal', status: 'in_progress' }
    session.cumStats = { tokens: 123, costUsd: 1.25, turns: 4 }
    session.lastTurnDelta = { tokens: 12, costUsd: 0.25, durationMs: 900 }
    session.currentTurnUsageBaseline = { total_tokens: 100 }
    session.currentTurnUsageBaselineKnown = true
    session.lastTurnUsage = { total_tokens: 120 }
    session.usageTotalsSeedUnknown = true

    session.resetFreshConversationState()

    expect(session.turnCounter).toBe(0)
    expect(session.currentGoal).toBeNull()
    expect(session.cumStats).toEqual({ tokens: 0, costUsd: 0, turns: 0 })
    expect(session.lastTurnDelta).toBeNull()
    expect(session.currentTurnUsageBaseline).toBeNull()
    expect(session.currentTurnUsageBaselineKnown).toBe(false)
    expect(session.lastTurnUsage).toBeNull()
    expect(session.usageTotalsSeedUnknown).toBe(false)
  })
})

describe('Session token accounting', () => {
  test('uses Claude result usage when resumed totals baseline is unknown', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.currentTurnUsageBaseline = null
    session.currentTurnUsageBaselineKnown = false
    session.usageTotalsSeedUnknown = true
    proc.lastResult = {
      cost_usd: 0.03,
      cost_delta_usd: 0.03,
      duration_ms: 1200,
      num_turns: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        total_tokens: 15,
      },
      subtype: 'success',
      is_error: false,
    }
    proc.lastTotalUsage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      total_tokens: 150,
    }

    session.accumulateResultStats()

    expect(session.lastTurnUsage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      total_tokens: 15,
    })
    expect(session.lastTurnDelta).toEqual({
      tokens: 12,
      costUsd: 0,
      durationMs: 1200,
    })
    expect(session.cumStats).toEqual({
      tokens: 12,
      costUsd: 0,
      turns: 1,
    })
  })
})

describe('Session assistant rendering', () => {
  test('buffers assistant deltas and inserts one completed markdown element without content streaming', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Hello')
      session.appendAssistant(', world')
      await cardkit.flush(turn.cardId)

      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
      expect(calls.some(call => call.method === 'POST' && call.path === `/cards/${turn.cardId}/elements`)).toBe(false)

      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      expect(JSON.parse(assistantAdd?.body.elements ?? '[]')).toEqual([{
        tag: 'markdown',
        element_id: 'assistant_0',
        content: 'Hello, world',
      }])

      const footerWrites = calls
        .filter(call => call.method === 'PUT' && call.path === `/cards/${turn.cardId}/elements/footer`)
        .map(call => JSON.parse(call.body.element).content as string)
      expect(footerWrites.some(content => content.startsWith('Writing...(0s)'))).toBe(true)
      expect(footerWrites.some(content => content.startsWith('Working...(0s)'))).toBe(true)
      expect(calls.some(call => call.path.endsWith('/content'))).toBe(false)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('treats askusr host markers as Codex-only', async () => {
    const session = new Session('probe', 'chat_id') as any
    const turn = turnState()
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.currentTurn = turn
    cardkit.recordCardCreated(turn.cardId, 1)

    try {
      session.appendAssistant('Before [[askusr: {"questions":[{"question":"Pick?","options":["A","B"]}]}]] after')
      session.finalizeCurrentAssistantSegment()
      await cardkit.flush(turn.cardId)

      expect(session.pendingHostAsks.size).toBe(0)
      expect(sentCards.length).toBe(0)
      const assistantAdd = calls.find(call =>
        call.method === 'POST' &&
        call.path === `/cards/${turn.cardId}/elements`
      )
      const elements = JSON.parse(assistantAdd?.body.elements ?? '[]')
      expect(elements[0]?.content).not.toContain('askusr')
      expect(elements[0]?.content).not.toContain('已发起澄清问题')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session compact command', () => {
  test('clears stale idle pending count before rejecting active turns', async () => {
    class FakeProc extends EventEmitter {
      sessionId = 'thread_stale_pending'
      turnId = 'turn_compact'
      compactCalls = 0

      isAlive(): boolean {
        return true
      }

      async compactThread(): Promise<void> {
        this.compactCalls++
        queueMicrotask(() => {
          this.emit('token_usage', {
            usage: { total_tokens: 5_361 },
            totalUsage: { total_tokens: 5_361 },
            contextWindow: 258_000,
            threadId: this.sessionId,
            turnId: this.turnId,
          })
          this.emit('context_compacted', {
            phase: 'end',
            threadId: this.sessionId,
            turnId: this.turnId,
          })
        })
      }
    }

    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeProc()
    session.proc = proc
    session.status = 'idle'
    session.initCount = 1
    session.pendingUserMessageCount = 1
    session.pendingReactionIds = new Map([['om_user_msg', 'reaction_one_second']])

    await expect(session.runCommand('cm')).resolves.toBe(true)

    expect(proc.compactCalls).toBe(1)
    expect(session.pendingUserMessageCount).toBe(0)
    expect(deletedReactions).toEqual([['om_user_msg', 'reaction_one_second']])
    expect(sentTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    expect(sentRawTexts.some(text => text.includes('先 `stop`'))).toBe(false)
    const footerWrites = calls
      .filter(call => call.method === 'PUT' && call.path.endsWith('/elements/footer'))
      .map(call => JSON.parse(call.body.element).content as string)
    expect(footerWrites.some(content =>
      content.includes('✅ 上下文已压缩') && content.includes('🧠 2% (5.4K/258K)')
    )).toBe(true)
  })
})

describe('Session provider switching', () => {
  test('uses provider-specific ask instructions', () => {
    const session = new Session('probe', 'chat_id') as any

    session.selectedProvider = 'codex'
    expect(session.spawnDeveloperInstructions()).toContain('[[askusr:')

    session.selectedProvider = 'claude'
    const instructions = session.spawnDeveloperInstructions()
    expect(instructions).toContain('AskUserQuestion')
    expect(instructions).not.toContain('[[askusr:')
  })

  test('keeps selected provider resume id from being overwritten by stale backend events', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastSessionId = 'claude-session-1'

    session.persistResumableSessionId()

    expect(boundResumes).toEqual([['probe', 'codex-thread-1', 'codex']])
    expect(session.lastSessionId).toBe('claude-session-1')
  })

  test('persists selected Claude resume id from init before a turn boundary', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-init')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-init' })

    expect(boundResumes).toEqual([['probe', 'claude-session-init', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-init')
  })

  test('persists selected Claude resume id from result if turn_started was missed', () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-result')
    session.proc = proc
    session.selectedProvider = 'claude'

    session.wireProc(proc)
    proc.emit('result', {})

    expect(boundResumes).toEqual([['probe', 'claude-session-result', 'claude']])
    expect(session.lastSessionId).toBe('claude-session-result')
  })

  test('rejects cross-provider model switch while a turn is active', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('codex', 'codex-thread-1')
    session.selectedProvider = 'codex'
    session.currentTurn = turnState()

    const result = await session.onModelEffortSelect('claude:glm', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('正在执行或排队')
    expect(boundResumes).toEqual([])
    expect(session.selectedProvider).toBe('codex')
  })

  test('respawns idle Claude process when selecting an env-backed model profile', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'

    const result = await session.onModelEffortSelect('claude:glm', 'max', '', 'ou_user', 'claude')

    expect(result.ok).toBe(true)
    expect(session.selectedModel).toBe('claude:glm')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(proc.setModelSettingsCalls).toEqual([])
    expect(result.card ? JSON.stringify(result.card) : '').toContain('下次启动 Claude')
  })

  test('rejects non-fixed Claude model outside the two fixed choices', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.selectedModel = 'claude:default'

    const result = await session.onModelEffortSelect('claude:deepseek', 'high', '', 'ou_user', 'claude')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不在固定选项中')
    expect(session.selectedModel).toBe('claude:default')
    expect(proc.killCalls).toBe(0)
  })

  test('catches synchronous Claude init failure before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      proc.emit('error', new Error('Claude auth failed'))
    }

    const ok = await session.start({
      announce: false,
      onStatus: status => statuses.push(status),
    })

    expect(ok).toBe(false)
    expect(statuses).toContain('❌ Claude 启动失败: Claude auth failed')
    expect(proc.killCalls).toBe(1)
    expect(session.proc).toBeNull()
    expect(session.status).toBe('stopped')
  })

  test('does not require Claude stream init before reporting ready', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    const statuses: string[] = []
    let initializeCalls = 0
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc
    proc.sendInitialize = () => {
      initializeCalls++
    }

    const ok = await session.start({
      announce: false,
      onStatus: status => statuses.push(status),
    })

    expect(ok).toBe(true)
    expect(initializeCalls).toBe(1)
    expect(statuses).toContain('✅ Claude 已就绪 · max')
    expect(proc.killCalls).toBe(0)
    expect(session.proc).toBe(proc)
    expect(session.status).toBe('idle')
  })

  test('sends cold-start Claude user text before stream init exists', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', null)
    session.selectedProvider = 'claude'
    session.spawnAgent = () => proc

    try {
      await session.startColdUserTurn('hello', 'hello', 'ou_user')

      expect(proc.sentTexts).toEqual(['hello'])
      expect(session.currentTurn).not.toBeNull()
      expect(session.status).toBe('working')
    } finally {
      session.stopFooterStatus(session.currentTurn)
      if (session.currentTurn) await cardkit.dispose(session.currentTurn.cardId)
    }
  })

})

describe('Session turn close vs mid-turn rotation race', () => {
  test('closeTurnCard awaits in-flight rotation so the swap-restarted footer interval is cleared (no orphan timer)', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = '' // 跳过 closeTurnCard 末尾 urgentApp(feishu mock 无此方法)
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)

    // 复现竞态:result 在 startMidTurnRotate 的 sendCard/id_convert await 窗口
    // 里抢先到达 → closeTurnCard 先跑;swap 随后才落定,切 turn.cardId 到新卡
    // 并 startWritingFooter 重启一个 footer 计时 interval。修复前这个 interval
    // 再没有路径会 stop(closeTurnCard 只跑一次;stop/kill/exit 的
    // stopFooterStatus(this.currentTurn) 拿到 null),新卡 footer 一直计时
    // (2026-06-26 turn=1 计时不止)。
    let swapRan = false
    let releaseSwap: () => void = () => {}
    turn.rotating = new Promise<void>(r => { releaseSwap = r }).then(() => {
      // swap 同步块(真实代码 startMidTurnRotate 1927/1932/1949)
      cardkit.recordCardCreated('card_new', 2)
      turn.cardId = 'card_new'
      session.startWritingFooter(turn)
      swapRan = true
    })

    try {
      const closed = session.closeTurnCard(undefined, { hasFreshResult: false })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      releaseSwap() // rotation 的 swap 现在落定
      await closed

      expect(swapRan).toBe(true)
      // swap 重启的 interval 必须被清掉,否则新卡 footer 一直计时
      expect(turn.footerStatusHandle).toBeNull()
      // 终态 footer 写到 swap 切换后的新卡,不是旧卡
      const newCardFooter = calls.filter(c => c.method === 'PUT' && c.path === '/cards/card_new/elements/footer')
      expect(newCardFooter.length).toBeGreaterThan(0)
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })
})

describe('Session workDir project profile override', () => {
  test('uses profile cwd when present', () => {
    projectProfiles.set('withoverride', { cwd: '/abs/custom/dir' })
    const session = new Session('withoverride', 'oc_test_override')
    expect(session.workDir).toBe('/abs/custom/dir')
  })

  test('falls back to PROJECTS_ROOT/<name> without profile', () => {
    const session = new Session('plainproject', 'oc_test_plain')
    expect(session.workDir).toBe('/tmp/lodestar-projects/plainproject')
  })

  test('ignores a blank cwd override', () => {
    projectProfiles.set('blankcwd', { cwd: '   ' })
    const session = new Session('blankcwd', 'oc_test_blank')
    expect(session.workDir).toBe('/tmp/lodestar-projects/blankcwd')
  })
})

describe('Session rotate cap counts only failure-triggered rotations', () => {
  // 2026-07-04 03:46 事故:turn 2 里 5 次正常满卡轮转(elementCount=50)把
  // rotateCount 耗光,第 2 次真实写失败(300308)一来就撞 cap 放弃。cap 的
  // 设计意图(session-types.ts)是只约束失败路径 —— 主动满卡轮转被真实输出
  // 天然节流,不该消耗失败额度。
  test('proactive full-card rotations do not consume the failure cap', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_old')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_old', 1)
    turn.rotateCount = 5 // 5 次主动满卡轮转已发生,但从未因写失败换过卡

    try {
      session.onCardWriteFailure(300308)

      expect(turn.rotateGivenUp).toBe(false)
      expect(turn.rotating).not.toBeNull()
      await turn.rotating
      expect(turn.cardId).not.toBe('card_old') // 真的换到了新卡
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose(turn.cardId)
    }
  })

  test('give-up stops the footer ticker, blocks its restart, and kills card writes', async () => {
    const session = new Session('probe', 'chat_id') as any
    session.proc = new FakeAgentProc('claude', 'claude-session-1')
    const turn = turnState('card_dead')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_dead', 1)
    turn.failureRotateCount = 5 // 失败额度已耗尽

    try {
      session.startWritingFooter(turn)
      expect(turn.footerStatusHandle).not.toBeNull()

      session.onCardWriteFailure(300308)

      expect(turn.rotateGivenUp).toBe(true)
      expect(turn.rotating).toBeNull() // 不再尝试换卡
      // 事故根因 1:log-only 后 footer 每秒 ticker 没停,对死卡刷了 11 分钟
      // 663 条 300308。放弃时必须停表,且 phase 切换不能把它拉起来。
      expect(turn.footerStatusHandle).toBeNull()
      session.startWorkingFooter(turn)
      expect(turn.footerStatusHandle).toBeNull()
      // log-only 语义:本轮剩余对该卡的写全部短路,不再打飞书。
      const before = calls.length
      await cardkit.replaceElement('card_dead', 'footer', { tag: 'markdown', element_id: 'footer', content: 'x' })
      await cardkit.addElement('card_dead', { tag: 'markdown', element_id: 'e_new', content: 'x' })
      expect(calls.length).toBe(before)
      // 告警文案说的是真实语义(换卡耗尽),不是「连续 N 次写入失败」
      expect(sentRawTexts.length).toBe(1)
      expect(sentRawTexts[0]).toContain('换卡')
      expect(sentRawTexts[0]).toContain('仅日志可见')
      expect(sentRawTexts[0]).not.toContain('连续 5 次写入失败')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_dead')
    }
  })
})

describe('Session SDK-initiated bg-task resume turns', () => {
  // 2026-07-04 事故:reviewer 后台 agent 完成 → SDK 自发恢复轮(init 无用户
  // 消息)合并出终报告,但 init handler 因 pendingUserMessageCount=0 不开卡,
  // appendAssistant 无 currentTurn 直接丢字 —— 6.6KB 终报告只存在于
  // transcript,飞书全程无痕。恢复轮必须开卡;开不了卡也必须纯文本兜底。
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  function emitClaudeResult(proc: any): void {
    proc.lastResult = {
      cost_usd: null,
      cost_delta_usd: null,
      duration_ms: 1000,
      num_turns: 1,
      usage: null,
      subtype: 'success',
      is_error: false,
    }
    proc.emit('result', {})
  }

  function wiredClaudeSession(): { session: any; proc: any } {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.lastUserOpenId = 'ou_user'
    session.wireProc(proc)
    proc.emit('init', { session_id: 'claude-session-1' }) // boot init,无用户批次,不开卡
    return { session, proc }
  }

  test('settle 后的自发 init 开 bg_task_resume 卡,终报告落卡、正常收尾并加急推送', async () => {
    const { session, proc } = wiredClaudeSession()
    expect(session.currentTurn).toBeNull()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // SDK 自发恢复轮
    await waitFor(() => session.currentTurn !== null)

    try {
      expect(session.currentTurn.trigger).toBe('bg_task_resume')
      expect(session.status).toBe('working')

      proc.emit('assistant_text', { text: '双盲 review 合并终报告' })
      proc.emit('assistant_block_stop', {})
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      // closeTurnCard 是 fire-and-forget:等终态 settings patch 落地再断言
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wroteReport = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('终报告'),
      )
      expect(wroteReport).toBe(true)
      expect(session.status).toBe('idle')
      expect(urgentPushes.length).toBe(1)
      expect(sentTexts).toEqual([]) // 走了卡,不该触发纯文本兜底
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('开卡窗口期先到的 assistant 文本并入新卡,不丢', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' })
    // openTurnCard 还在 await sendCard/id_convert,文本已经开始流 —— 事故里
    // 55ms 后模型就开写。这些字必须并入随后落地的卡。
    proc.emit('assistant_text', { text: '窗口期先到的段落' })
    proc.emit('assistant_block_stop', {})
    await waitFor(() => session.currentTurn !== null)

    try {
      emitClaudeResult(proc)
      await waitFor(() => session.currentTurn === null)
      await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

      const wrote = calls.some(c =>
        c.method === 'POST' &&
        /\/cards\/[^/]+\/elements$/.test(c.path) &&
        String(c.body?.elements ?? '').includes('窗口期先到的段落'),
      )
      expect(wrote).toBe(true)
    } finally {
      if (session.currentTurn) {
        session.stopFooterStatus(session.currentTurn)
        await cardkit.dispose(session.currentTurn.cardId)
      }
    }
  })

  test('没有 settle 的空 init 不开卡(probe/模型切换等场景不受影响)', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('init', { session_id: 'claude-session-1' }) // 无 settle、无用户批次
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(session.currentTurn).toBeNull()
    expect(sentCards.length).toBe(0)
  })

  test('恢复轮开卡失败(id_convert 报错)时,输出纯文本兜底不丢', async () => {
    const { session, proc } = wiredClaudeSession()
    // 让本轮 id_convert 报错 → openTurnCard 拿不到 cardId → 开卡失败。
    const base = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cards/id_convert')) {
        return new Response(JSON.stringify({ code: 99, msg: 'boom' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return base(input, init)
    }) as typeof fetch

    try {
      proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
      proc.emit('init', { session_id: 'claude-session-1' })
      // 开卡在 await 中就会失败;这些字必须仍被兜住(开卡窗口 + cardless 续窗)。
      proc.emit('assistant_text', { text: '孤儿终报告内容' })
      proc.emit('assistant_block_stop', {})
      await waitFor(() => session.bgResumeCardless === true || session.currentTurn !== null)
      emitClaudeResult(proc)
      await waitFor(() => sentTexts.length > 0)

      expect(sentTexts.join('\n')).toContain('孤儿终报告内容')
      expect(session.currentTurn).toBeNull()
    } finally {
      globalThis.fetch = base
    }
  })

  test('用户打断后,残留的 post-interrupt 正文被丢弃,不推送 📄 兜底消息', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'claude'
    session.wireProc(proc)
    const turn = turnState('card_live')
    turn.userOpenId = ''
    session.currentTurn = turn
    cardkit.recordCardCreated('card_live', 1)

    try {
      // 模拟软停止:置 userInterrupted、封口卡片(currentTurn 置空)。
      session.userInterrupted = true
      await session.closeTurnCard('🛑 打断')
      expect(session.currentTurn).toBeNull()

      // interrupt 落地前 SDK 仍在流式:这些 delta 到达时已无卡。旧行为是
      // 静默丢弃 —— 修复后必须仍然丢弃,不能变成 📄 纯文本兜底。
      proc.emit('assistant_text', { text: '被取消的轮次尾巴' })
      proc.emit('assistant_block_stop', {})
      emitClaudeResult(proc)
      await new Promise(resolve => setTimeout(resolve, 30))

      expect(sentTexts.join('\n')).not.toContain('被取消的轮次尾巴')
      expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
      expect(session.status).toBe('idle')
    } finally {
      session.stopFooterStatus(turn)
      await cardkit.dispose('card_live')
    }
  })

  test('result 抢在 bg-resume 开卡 await 窗口内到达:不重复兜底,卡片正常收尾,不卡在 working', async () => {
    const { session, proc } = wiredClaudeSession()

    proc.emit('bg_task_settled', { task_id: 't1', status: 'completed' })
    proc.emit('init', { session_id: 'claude-session-1' }) // 开始开卡(await sendCard/id_convert)
    proc.emit('assistant_text', { text: '短恢复轮输出' })
    proc.emit('assistant_block_stop', {})
    // 开卡还没落地(openingTurn 仍 true)就来 result —— 竞态窗口。
    emitClaudeResult(proc)

    await waitFor(() => session.currentTurn === null && session.openingTurn === false)
    await waitFor(() => calls.some(c => c.method === 'PATCH' && c.path.includes('/settings')))

    // 文本进了卡(不是纯文本兜底),且只出现一次。
    expect(sentTexts.some(t => t.includes('📄'))).toBe(false)
    const inCard = calls.some(c =>
      c.method === 'POST' &&
      /\/cards\/[^/]+\/elements$/.test(c.path) &&
      String(c.body?.elements ?? '').includes('短恢复轮输出'),
    )
    expect(inCard).toBe(true)
    // 卡片已收尾(有终态 settings patch),session 不卡在 working。
    expect(session.status).toBe('idle')
  })

  test('切换 provider 停旧进程时清掉 bgResumePending,新进程 boot init 不误开恢复卡', async () => {
    const session = new Session('probe', 'chat_id') as any
    const proc = new FakeAgentProc('claude', 'claude-session-1')
    session.proc = proc
    session.selectedProvider = 'codex' // 与 proc.provider 不一致 → 视为 idle mismatched
    session.bgResumePending = true

    await session.stopIdleMismatchedProcess()

    expect(session.bgResumePending).toBe(false)
    expect(session.proc).toBeNull()
  })

  test('非开卡/非恢复窗口的游离正文被丢弃,不进孤儿缓冲', () => {
    const session = new Session('probe', 'chat_id') as any
    // 无 currentTurn、无 openingTurn、无 bgResumeCardless:任何游离 delta 都该丢。
    session.appendAssistant('进程 kill 窗口的残字')
    session.finalizeCurrentAssistantSegment()

    expect(session.orphanAssistantSegments).toEqual([])
    expect(session.orphanAssistantCurrent).toBe('')
  })
})

describe('Session usage cache cross-backend isolation', () => {
  test('claude 的 rate_limit_event payload 不得覆盖 codex 用量缓存', () => {
    // 先用一条 codex 形状的 payload 播种缓存(模块级单例)。
    const seeded = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })
    expect(seeded.state).toBe('ok')

    const session = new Session('probe', 'chat_id') as any
    const claudeProc = new FakeAgentProc('claude')
    session.wireProc(claudeProc)
    // claude 的 rate_limit_info 形状(无 planType/primary/secondary):
    // truthy 但与 codex 完全不同,穿过共享 handler 会被包成空窗口 ok 快照。
    claudeProc.emit('rate_limits_updated', { status: 'allowed', unified_status: 'allowed' })

    // 缓存对象必须原封不动(恒等,而非结构相等)。
    expect(peekUsage()).toBe(seeded)
  })

  test('codex 的 rate_limits_updated 照常更新用量缓存', () => {
    const session = new Session('probe', 'chat_id') as any
    const codexProc = new FakeAgentProc('codex')
    session.wireProc(codexProc)
    codexProc.emit('rate_limits_updated', {
      planType: 'pro',
      primary: { usedPercent: 7, resetsAt: 1_700_000_000, windowDurationMins: 300 },
    })

    const snap = peekUsage() as any
    expect(snap?.state).toBe('ok')
    expect(snap?.subscriptionType).toBe('pro')
    expect(snap?.fiveHour?.percent).toBe(7)
  })
})
