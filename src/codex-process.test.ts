import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  imageGenerationOutput,
  usageFromTokenUsagePayload,
} from './codex-process'

describe('codex process compaction notifications', () => {
  test('detects explicit thread compaction notifications', () => {
    const notice = contextCompactionNoticeFromNotification('thread/compacted', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(notice?.sourceMethod).toBe('thread/compacted')
    expect(notice?.threadId).toBe('thread-1')
    expect(notice?.turnId).toBe('turn-1')
  })

  test('detects Codex event messages persisted as context_compacted', () => {
    const notice = contextCompactionNoticeFromNotification('event_msg', {
      type: 'context_compacted',
    })

    expect(notice?.sourceMethod).toBe('event_msg')
    expect(notice?.sourceType).toBe('context_compacted')
    expect(notice?.phase).toBe('end')
  })

  test('detects raw compacted records with replacement history', () => {
    const notice = contextCompactionNoticeFromMessage({
      timestamp: '2026-06-03T16:03:16.331Z',
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
    })

    expect(notice?.sourceMethod).toBe('compacted')
    expect(notice?.sourceType).toBe('compacted')
    expect(notice?.phase).toBe('start')
    expect(notice?.timestamp).toBe('2026-06-03T16:03:16.331Z')
    expect(notice?.replacement_history).toHaveLength(1)
  })

  test('detects raw response compaction items', () => {
    const notice = contextCompactionNoticeFromNotification('rawResponseItem/completed', {
      item: {
        type: 'contextCompaction',
        id: 'item-1',
      },
      threadId: 'thread-2',
    })

    expect(notice?.sourceMethod).toBe('rawResponseItem/completed')
    expect(notice?.sourceType).toBe('contextCompaction')
    expect(notice?.phase).toBe('end')
    expect(notice?.itemId).toBe('item-1')
    expect(notice?.threadId).toBe('thread-2')
  })

  test('marks live app-server context compaction item start and completion', () => {
    const started = contextCompactionNoticeFromNotification('item/started', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })
    const completed = contextCompactionNoticeFromNotification('item/completed', {
      item: {
        type: 'contextCompaction',
        id: 'compact-1',
        replacementHistory: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息' }] },
        ],
      },
      threadId: 'thread-3',
      turnId: 'turn-3',
    })

    expect(started?.phase).toBe('start')
    expect(started?.itemId).toBe('compact-1')
    expect(started?.threadId).toBe('thread-3')
    expect(completed?.phase).toBe('end')
    expect(completed?.itemId).toBe('compact-1')
    expect(completed?.replacementHistory).toHaveLength(1)
  })

  test('ignores unrelated notifications', () => {
    expect(contextCompactionNoticeFromNotification('thread/settings/updated', {
      threadSettings: { model: 'gpt-5' },
    })).toBeNull()
  })

  test('unmapped app-server notifications are logged without breaking message handling', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const raw: unknown[] = []
    const compacted: unknown[] = []
    proc.opts = { workDir: '/tmp' }
    proc.emit = (event: string, payload: unknown) => {
      if (event === 'raw') raw.push(payload)
      if (event === 'context_compacted') compacted.push(payload)
      return true
    }

    expect(() => proc.handleNotification('item/started', {
      item: { type: 'contextCompaction', id: 'compact-2' },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    expect(() => proc.handleNotification('thread/status/changed', {
      threadId: 'thread-4',
      status: { type: 'idle' },
    })).not.toThrow()
    expect(() => proc.handleNotification('item/started', {
      item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] },
      threadId: 'thread-4',
      turnId: 'turn-4',
    })).not.toThrow()
    // reasoning item 走 UNMAPPED log(不 emit raw);thread/status/changed 已被
    // 子 agent 状态机消费(exec-cell 编排的终态信号),不再落 raw。
    expect(raw).toHaveLength(0)
    expect(compacted).toHaveLength(1)
  })

  test('maps snake_case image generation fields to a sendable result path', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.emittedImageGenerationIds = new Set()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    proc.handleNotification('item/started', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'inProgress',
        revised_prompt: 'A cute cat curled up in a sunbeam.',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'imageGeneration',
        id: 'img-1',
        status: 'completed',
        revised_prompt: 'A cute cat curled up in a sunbeam.',
        saved_path: '/tmp/cat.png',
        result: 'ignored when saved_path exists',
      },
      threadId: 'thread-5',
      turnId: 'turn-5',
    })

    expect(events).toEqual([
      ['tool_use', {
        id: 'img-1',
        name: 'ImageGeneration',
        input: {
          status: 'inProgress',
          revisedPrompt: 'A cute cat curled up in a sunbeam.',
        },
      }],
      ['tool_result', {
        tool_use_id: 'img-1',
        content: '/tmp/cat.png',
        is_error: false,
      }],
    ])
  })

  test('materializes inline base64 image generation results to a sendable file path', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-imggen-'))
    try {
      const output = imageGenerationOutput({
        call_id: 'ig-inline',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      }, 'thread-inline', root)

      expect(output).toBe(join(root, 'thread-inline', 'ig-inline.png'))
      expect(readFileSync(output).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('codex token usage helpers', () => {
  test('parses app-server token usage payloads for last and total snapshots', () => {
    expect(usageFromTokenUsagePayload({
      totalTokens: 1200,
      inputTokens: 900,
      outputTokens: 300,
      reasoningOutputTokens: 220,
      cachedInputTokens: 400,
    })).toEqual({
      total_tokens: 1200,
      input_tokens: 900,
      output_tokens: 300,
      reasoning_output_tokens: 220,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 400,
    })
  })

  test('computes turn aggregate from absolute thread totals', () => {
    const usage = diffUsageTotals(
      {
        total_tokens: 10_000,
        input_tokens: 7_000,
        output_tokens: 3_000,
        reasoning_output_tokens: 1_200,
        cache_read_input_tokens: 2_800,
      },
      {
        total_tokens: 4_000,
        input_tokens: 3_100,
        output_tokens: 900,
        reasoning_output_tokens: 500,
        cache_read_input_tokens: 1_200,
      },
    )

    expect(usage).toEqual({
      total_tokens: 6000,
      input_tokens: 3900,
      output_tokens: 2100,
      reasoning_output_tokens: 700,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 1600,
    })
    expect(effectiveTurnTokens(usage)).toBe(6000)
    expect(effectiveTurnTokens({ total_tokens: 1234 })).toBe(1234)
    expect(effectiveTurnTokens(null)).toBeNull()
  })

  test('clamps negative deltas and treats missing totals as unknown', () => {
    expect(diffUsageTotals(
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 120, output_tokens: 10 },
    )).toEqual({
      total_tokens: undefined,
      input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    })
    expect(diffUsageTotals(null, null)).toBeNull()
  })
})

describe('codex collab agent translation (ultra multi-agent)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subAgentActivity started → bg_task_started + promoted; completed terminal via collabAgentToolCall → bg_task_settled', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_1',
        kind: 'started',
        agentThreadId: 'agent-thread-1',
        agentPath: '/root/order_schema/official_history_orders',
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const bgEvents = events.filter(([e]) => e.startsWith('bg_task'))
    expect(bgEvents).toEqual([
      ['bg_task_started', {
        task_id: 'agent-thread-1',
        task_type: 'local_agent',
        description: 'official_history_orders',
        prompt: undefined,
      }],
      ['bg_task_updated', {
        task_id: 'agent-thread-1',
        patch: { is_backgrounded: true },
      }],
    ])

    // wait 调用携带 agentsStates:running → updated;completed(message)→ settled。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_2',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-1',
      status: 'completed',
      summary: '调查结论:可以改',
    }]])

    // 同 agent 的后续 wait item 重复携带终态 → 不重复结算、不翻活。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_3',
        tool: 'wait',
        status: 'completed',
        agentsStates: {
          'agent-thread-1': { status: 'completed', message: '调查结论:可以改' },
        },
      },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
  })

  test('spawnAgent emits one Agent tool panel (started) and closes it once (completed)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        prompt: '调查 history_orders 接口',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // spawn started:一个 Agent tool_use + bg_task_started/promoted(先于 subAgentActivity)
    const toolUses = events.filter(([e]) => e === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0][1].name).toBe('Agent')
    expect(toolUses[0][1].input.description).toBe('派生 1 个子 agent')

    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['agent-thread-2'],
        agentsStates: { 'agent-thread-2': { status: 'running', message: null } },
      },
      threadId: 'main-thread',
      turnId: 'turn-2',
    })

    // completed 不再补 tool_use,只补 tool_result 关面板。
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
    const results = events.filter(([e]) => e === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0][1].tool_use_id).toBe('spawn-1')
    expect(results[0][1].content).toContain('agent-th: running')
  })

  test('pure orchestration calls (wait/sendInput/closeAgent) emit no tool panels', () => {
    const { proc, events } = makeProc()
    for (const tool of ['wait', 'sendInput', 'resumeAgent', 'closeAgent']) {
      proc.handleNotification('item/started', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'inProgress', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
      proc.handleNotification('item/completed', {
        item: { type: 'collabAgentToolCall', id: `x-${tool}`, tool, status: 'completed', agentsStates: {} },
        threadId: 'main-thread', turnId: 'turn-3',
      })
    }
    expect(events.filter(([e]) => e === 'tool_use' || e === 'tool_result')).toHaveLength(0)
  })

  test('errored agent settles as failed; unknown orchestration items stay out of UNHANDLED noise', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity',
        id: 'call_9',
        kind: 'started',
        agentThreadId: 'agent-thread-3',
        agentPath: '/root/fix_bug',
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_10',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-thread-3': { status: 'errored', message: 'context window exceeded' } },
      },
      threadId: 'main-thread', turnId: 'turn-4',
    })

    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'agent-thread-3',
      status: 'failed',
      summary: 'context window exceeded',
    }]])
    expect(events.filter(([e]) => e === 'raw')).toHaveLength(0)
  })
})

describe('codex collab followup reactivation', () => {
  test('settled agent re-runs via followup: revive then settle again', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }

    const startedItem = {
      type: 'subAgentActivity',
      id: 'call_a',
      kind: 'started',
      agentThreadId: 'agent-r',
      agentPath: '/root/final_review',
    }
    proc.handleNotification('item/started', { item: startedItem, threadId: 'm', turnId: 't' })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w1',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '初审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)

    // followup_task:agent 重新 running → 补 started+promote 让沉降后已清空的
    // entry 重新入池,running patch 翻活墓碑。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w2',
        tool: 'sendInput',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const tail = events.filter(([e]) => e.startsWith('bg_task')).slice(-3)
    expect(tail.map(([e]) => e)).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_updated'])
    expect(tail[0][1].description).toBe('final_review')
    expect(tail[2][1].patch).toEqual({ status: 'running' })

    // 第二次完成 → 重新结算,summary 换新。
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'w3',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'agent-r': { status: 'completed', message: '复审完成' } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toHaveLength(2)
    expect(settled[1][1].summary).toBe('复审完成')
  })
})

describe('codex collab closeAgent and terminal-first edge cases', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('closeAgent settles receivers as stopped even when snapshot says running', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa1', kind: 'started',
        agentThreadId: 'ag-1', agentPath: '/root/worker',
      },
      threadId: 'm', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'c1', tool: 'closeAgent', status: 'completed',
        receiverThreadIds: ['ag-1'],
        agentsStates: { 'ag-1': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-1', status: 'stopped' }]])
  })

  test('terminal-first agent: started+promoted+settled in one item, no running patch after settle', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w9', tool: 'wait', status: 'completed',
        receiverThreadIds: ['ag-fast'],
        agentsStates: { 'ag-fast': { status: 'completed', message: '秒完' } },
      },
      threadId: 'm', turnId: 't',
    })
    const kinds = events.filter(([e]) => e.startsWith('bg_task')).map(([e]) => e)
    expect(kinds).toEqual(['bg_task_started', 'bg_task_updated', 'bg_task_settled'])
  })

  test('spawn-first uses placeholder name; subAgentActivity later patches real name', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp1', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-2'], prompt: 'gAAAAABciphertext',
        agentsStates: { 'ag-2': { status: 'running', message: null } },
      },
      threadId: 'm', turnId: 't',
    })
    const firstStarted = events.find(([e]) => e === 'bg_task_started')!
    expect(firstStarted[1].description).toBe('子 agent')
    expect(firstStarted[1].prompt).toBe('(继承主线程历史的密文任务书)')

    proc.handleNotification('item/started', {
      item: {
        type: 'subAgentActivity', id: 'sa2', kind: 'started',
        agentThreadId: 'ag-2', agentPath: '/root/etl/orders',
      },
      threadId: 'm', turnId: 't',
    })
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds).toHaveLength(2)
    expect(starteds[1][1].description).toBe('orders')
  })
})

describe('codex subagent item filtering (main-card cleanliness)', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('subagent-thread commandExecution becomes subagent_step, not tool_use', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', cwd: '/tmp' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'commandExecution', id: 'exec-1', command: 'pytest -q', aggregatedOutput: '3 passed', exitCode: 0 },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(0)
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(2)
    expect(steps[0][1]).toMatchObject({ thread_id: 'sub-thread-1', tool: 'Bash', phase: 'started' })
  })

  test('subagent Bash step brief unwraps PowerShell-wrapped desc command', () => {
    // Windows 上 Codex 把命令包进 powershell.exe 调用,子 agent 后台卡 steps
    // 的 brief 也要显示中文说明,不显示 powershell.exe 路径。
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: {
        type: 'commandExecution', id: 'exec-ps', cwd: 'C:\\repo',
        command: `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Command '# desc: 查看模板目录状态\nGet-ChildItem "C:\\repo\\templates" -Recurse'`,
      },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    const steps = events.filter(([e]) => e === 'subagent_step')
    expect(steps).toHaveLength(1)
    expect((steps[0][1] as any).brief).toBe('查看模板目录状态')
  })

  test('subagent agentMessage does not leak into main assistant stream', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-sub', text: '子 agent 阶段性输出' },
      threadId: 'sub-thread-1',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(0)
    // 主线程的 agentMessage 不受影响
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'msg-main', text: '主线程正文' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'assistant_block_stop')).toHaveLength(1)
  })

  test('main-thread commandExecution still emits tool_use (unchanged behavior)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-2', command: 'ls', cwd: '/tmp' },
      threadId: 'main-thread',
      turnId: 'turn-1',
    })
    expect(events.filter(([e]) => e === 'tool_use')).toHaveLength(1)
  })
})

describe('codex subagent step filtering', () => {
  test('reasoning items produce no subagent_step (step budget reserved for tools)', () => {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    for (const phase of ['item/started', 'item/completed'] as const) {
      proc.handleNotification(phase, {
        item: { type: 'reasoning', id: 'rs-1', summary: [], content: ['思考中…'] },
        threadId: 'sub-thread-1',
        turnId: 't',
      })
    }
    // reasoning 完成也不出 step
    expect(events.filter(([e]) => e === 'subagent_step')).toHaveLength(0)
  })
})

describe('codex exec-cell orchestration via thread/status/changed', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('idle(create)→active→idle(complete) settles as completed; create-idle does not', () => {
    const { proc, events } = makeProc()
    // spawn 信号(subAgentActivity)先到
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-x', agentPath: '/root/etl' },
      threadId: 'main-thread', turnId: 't',
    })
    // 创建态 idle:不结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(0)
    // active:running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'active', activeFlags: [] } })
    // 完成态 idle:结算 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-x', status: { type: 'idle' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', { task_id: 'ag-x', status: 'completed' }]])
  })

  test('revive after idle: second active re-enters pool and settles again', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-y', agentPath: '/root/rev' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    // 复活:followup 再拉起 → settled 清除,重新入池 running
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'active' } })
    const revived = events.filter(([e]) => e === 'bg_task_settled')
    expect(revived).toHaveLength(1) // 尚未第二次 idle
    const lastStarted = events.filter(([e]) => e === 'bg_task_started').at(-1)!
    expect(lastStarted[1].description).toBe('rev')
    proc.handleNotification('thread/status/changed', { threadId: 'ag-y', status: { type: 'idle' } })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(2)
  })

  test('main-thread and unknown-thread status changes are ignored', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('thread/status/changed', { threadId: 'main-thread', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'unknown-ag', status: { type: 'active' } })
    expect(events.filter(([e]) => e.startsWith('bg_task'))).toHaveLength(0)
  })
})

describe('codex review-round-3 fixes', () => {
  function makeProc(): { proc: any; events: Array<[string, any]> } {
    const proc = Object.create(CodexProcess.prototype) as any
    const events: Array<[string, any]> = []
    proc.opts = { workDir: '/tmp' }
    proc.collabAgentNames = new Map()
    proc.collabAgentSettled = new Set()
    proc.collabAgentSummaries = new Map()
    proc.collabAgentWasActive = new Set()
    proc.sessionId = 'main-thread'
    proc.emit = (event: string, payload: unknown) => {
      events.push([event, payload])
      return true
    }
    return { proc, events }
  }

  test('child turn/completed does not emit main result (entry-level threadId filter)', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('turn/completed', {
      threadId: 'sub-thread',
      turn: { id: 'turn-sub', status: 'completed', durationMs: 1000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(0)
    // 主线程 turn 照常
    proc.handleNotification('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-main', status: 'completed', durationMs: 2000 },
    })
    expect(events.filter(([e]) => e === 'result')).toHaveLength(1)
  })

  test('child agentMessage/delta does not emit assistant_text', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'sub-thread', turnId: 't', itemId: 'msg-sub', delta: '子agent输出',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(0)
    proc.handleNotification('item/agentMessage/delta', {
      threadId: 'main-thread', turnId: 't', itemId: 'msg-main', delta: '主线程正文',
    })
    expect(events.filter(([e]) => e === 'assistant_text')).toHaveLength(1)
  })

  test('child tokenUsage does not overwrite main-thread usage', () => {
    const { proc, events } = makeProc()
    proc.lastUsage = { total_tokens: 999 }
    proc.handleNotification('thread/tokenUsage/updated', {
      threadId: 'sub-thread', turnId: 't',
      tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: 2 } },
    })
    expect(events.filter(([e]) => e === 'token_usage')).toHaveLength(0)
    expect(proc.lastUsage.total_tokens).toBe(999)
  })

  test('systemError settles as failed; agentMessage text becomes settle summary', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-e', agentPath: '/root/review' },
      threadId: 'main-thread', turnId: 't',
    })
    proc.handleNotification('item/completed', {
      item: { type: 'agentMessage', id: 'm1', text: '审查结论:发现 2 处问题' },
      threadId: 'ag-e', turnId: 't',
    })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-e', status: { type: 'systemError' } })
    const settled = events.filter(([e]) => e === 'bg_task_settled')
    expect(settled).toEqual([['bg_task_settled', {
      task_id: 'ag-e', status: 'failed', summary: '审查结论:发现 2 处问题',
    }]])
  })

  test('authoritative agentsStates terminal corrects fallback completed into failed', () => {
    const { proc, events } = makeProc()
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa', kind: 'started', agentThreadId: 'ag-c', agentPath: '/root/x' },
      threadId: 'main-thread', turnId: 't',
    })
    // idle 兜底先结算成 completed
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-c', status: { type: 'idle' } })
    // 权威 agentsStates 随后带 errored → 墓碑纠正为 failed,不翻活
    proc.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall', id: 'w', tool: 'wait', status: 'completed',
        agentsStates: { 'ag-c': { status: 'errored', message: 'boom' } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled')).toHaveLength(1)
    const corrections = events.filter(([e, p]) => e === 'bg_task_updated' && (p as any).patch?.status === 'failed')
    expect(corrections).toHaveLength(1)
    expect((corrections[0][1] as any).patch.error).toBe('boom')
  })

  test('late subAgentActivity name patch does not revive a settled task', () => {
    const { proc, events } = makeProc()
    // spawn-first 占位
    proc.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall', id: 'sp', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['ag-l'], agentsStates: { 'ag-l': { status: 'running', message: null } },
      },
      threadId: 'main-thread', turnId: 't',
    })
    // 结算
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'active' } })
    proc.handleNotification('thread/status/changed', { threadId: 'ag-l', status: { type: 'idle' } })
    const settledBefore = events.filter(([e]) => e === 'bg_task_settled').length
    // 晚到的 subAgentActivity(started)带真名 —— 只改 map,不发 started(不复活)
    proc.handleNotification('item/started', {
      item: { type: 'subAgentActivity', id: 'sa-late', kind: 'started', agentThreadId: 'ag-l', agentPath: '/root/real_name' },
      threadId: 'main-thread', turnId: 't',
    })
    expect(events.filter(([e]) => e === 'bg_task_settled').length).toBe(settledBefore)
    const starteds = events.filter(([e]) => e === 'bg_task_started')
    expect(starteds.length).toBe(1) // 只有 spawn-first 那次
  })
})
