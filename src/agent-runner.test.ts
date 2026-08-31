import { describe, expect, test } from 'bun:test'
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
