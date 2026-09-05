import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { collectAgentTurn } from './agent-runner'

class FakeProcess extends EventEmitter {
  provider = 'claude' as const
  tokenSourceId = 'glm'
  sessionId: string | null = 'sid-1'
  lastAssistantUuid: string | null = 'checkpoint-1'
  lastCompletedTurnId = null
  lastModel = 'GLM-5.3'
  lastEffort = 'max' as const
  lastUsage = null
  lastTotalUsage = null
  lastResult = { subtype: 'success', is_error: false } as any
  lastContextWindow = null
  lastContextTokens = null
  alive = true
  initialized = false
  prompts: string[] = []
  permissionResponses: any[] = []

  sendInitialize() { this.initialized = true }
  sendUserText(text: string) { this.prompts.push(text) }
  sendPermissionResponse(...args: any[]) { this.permissionResponses.push(args) }
  sendHookResponse() {}
  async kill() { this.alive = false; this.emit('exit', { code: 0, signal: null, expected: true }) }
  isAlive() { return this.alive }
}

describe('full delegated Agent runner', () => {
  test('capacity backoff pauses the watchdog, reports progress and stays out of the agent output', async () => {
    const timers = new Map<number, number>()
    let nextId = 100_000
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((_callback: () => void, delay: number) => {
      const id = nextId++
      timers.set(id, delay)
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id) }) as typeof clearTimeout)
    const proc = new FakeProcess() as any
    proc.provider = 'codex'
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', { onProgress: step => progress.push(step) }, () => {})
    try {
      expect([...timers.values()]).toEqual([30 * 60 * 1000])
      const retry = { phase: 'waiting', attempt: 1, delayMs: 60_000, message: 'Selected model is at capacity' }
      proc.emit('turn_retry', retry)
      expect(timers.size).toBe(0)
      expect(proc.alive).toBe(true)
      expect(progress.at(-1).detail).toContain(retry.message)
      proc.emit('turn_retry', { ...retry, phase: 'retrying', delayMs: 0 })
      expect([...timers.values()]).toEqual([30 * 60 * 1000])
      proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
      proc.emit('result', { is_error: false })
      await expect(handle.done).resolves.toMatchObject({ output: 'finished' })
      expect(timers.size).toBe(0)
      expect(proc.listenerCount('turn_retry')).toBe(0)
    } finally {
      await handle.cancel()
      timeout.mockRestore()
      clear.mockRestore()
    }
  })

  test('auto-allows ordinary permissions but pauses and resumes exact input requests', async () => {
    const proc = new FakeProcess() as any
    const waiting: any[] = []
    const progress: any[] = []
    const handle = collectAgentTurn(proc, 'do work', {
      onNeedsInput: request => waiting.push(request),
      onProgress: step => progress.push(step),
    }, () => {})
    expect(proc.initialized).toBe(true)
    expect(proc.prompts).toEqual(['do work'])

    proc.emit('can_use_tool', { request_id: 'perm', tool_name: 'Bash', input: { command: 'touch x' } })
    expect(proc.permissionResponses[0]).toEqual(['perm', 'allow', { updatedInput: { command: 'touch x' } }])
    proc.emit('tool_use', { name: 'Bash', input: { command: 'cat .env', token: 'secret' } })
    proc.emit('tool_result', { content: 'API_KEY=secret', is_error: false })
    expect(progress.map(step => step.detail)).toEqual(['', ''])

    proc.emit('can_use_tool', {
      request_id: 'ask', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1',
      input: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
    })
    expect(waiting[0]).toMatchObject({ requestId: 'ask', questions: [{ id: 'q1', question: 'Proceed?' }] })
    handle.answer('ask', { q1: 'Yes' })
    expect(proc.permissionResponses[1]).toEqual([
      'ask', 'allow',
      { updatedInput: { questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }] }], answers: { q1: 'Yes' } } },
    ])

    proc.emit('assistant_text', { text: 'finished', parentToolUseId: null })
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: 'finished', sessionId: 'sid-1', checkpointId: 'checkpoint-1' })
  })

  test('treats a successful file-only turn with no assistant text as completed', async () => {
    const proc = new FakeProcess() as any
    const handle = collectAgentTurn(proc, 'edit files', {}, () => {})
    proc.emit('result', { is_error: false, checkpoint: { id: 'checkpoint-1' } })
    await expect(handle.done).resolves.toMatchObject({ output: '', sessionId: 'sid-1' })
  })
})
