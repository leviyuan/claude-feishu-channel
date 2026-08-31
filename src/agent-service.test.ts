import { describe, expect, test } from 'bun:test'
import { AgentService, type AgentServiceDeps } from './agent-service'
import type { AgentIdentity, AgentIdentityCatalog } from './agent-identities'
import type { AgentWorkerHandle, AgentWorkerResult } from './agent-runner'

function identity(id: string, name = id): AgentIdentity {
  return {
    id: `agent:${id}`, displayName: name, tokenSourceId: id, tokenSourceDisplay: id,
    provider: id === 'codex' ? 'codex' : 'claude', model: `model-${id}`, modelDisplay: name,
    defaultEffort: 'max', supportedEfforts: ['low', 'max'], sourceDefault: true, status: 'ready',
  }
}

const session = {
  sessionName: 'project', chatId: 'chat-1', workDir: '/repo',
  delegatedAgentDeveloperInstructions: () => '',
  worktreeProjectName: () => 'project',
} as any

function result(sessionId: string, output = 'done'): AgentWorkerResult {
  return { output, outputTruncated: false, sessionId, checkpointId: 'checkpoint', durationMs: 10, usage: null }
}

function resolvedHandle(value: AgentWorkerResult): AgentWorkerHandle {
  return {
    done: Promise.resolve(value),
    pendingInput: () => null,
    answer: () => { throw new Error('not waiting') },
    cancel: async () => {},
  }
}

function controlledHandle(): {
  handle: AgentWorkerHandle
  resolve(value: AgentWorkerResult): void
  reject(error: Error): void
} {
  let resolve!: (value: AgentWorkerResult) => void
  let reject!: (error: Error) => void
  let pending: any = null
  const done = new Promise<AgentWorkerResult>((ok, fail) => { resolve = ok; reject = fail })
  return {
    handle: {
      done,
      pendingInput: () => pending,
      answer: () => {},
      async cancel(reason = 'cancelled') { reject(new Error(reason)); await done.catch(() => {}) },
    },
    resolve,
    reject,
  }
}

function harness(opts: {
  identities?: AgentIdentity[]
  startWorker?: AgentServiceDeps['startWorker']
  loadArtifacts?: AgentServiceDeps['loadArtifacts']
  sendCard?: AgentServiceDeps['sendCard']
  patchSettingsChecked?: AgentServiceDeps['patchSettingsChecked']
} = {}) {
  const identities = opts.identities ?? [identity('a', 'Agent A')]
  const catalog: AgentIdentityCatalog = { catalogGeneration: 'g1', identities, sourceFailures: [] }
  const artifacts: unknown[] = []
  const textArtifacts = new Map<string, string>()
  const deps: AgentServiceDeps = {
    getCatalog: () => catalog,
    startWorker: opts.startWorker ?? (worker => resolvedHandle(result(`sid-${worker.identity.id}`, `output-${worker.identity.id}`))),
    sendCard: opts.sendCard ?? (async () => 'message-1'),
    sendTextRaw: async () => true,
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementChecked: async () => true,
    patchSummaryThrottled: () => {},
    flush: async () => {},
    cancelSummary: () => {},
    patchSettingsChecked: opts.patchSettingsChecked ?? (async () => true),
    dispose: async () => {},
    writeArtifact: (_path, value) => { artifacts.push(JSON.parse(JSON.stringify(value))) },
    writeTextArtifact: (path, value) => { textArtifacts.set(path, value) },
    loadArtifacts: opts.loadArtifacts ?? (() => []),
  }
  const service = new AgentService(deps)
  return { service, root: service.rootPrincipal(session), artifacts, textArtifacts }
}

async function waitFor(
  service: AgentService,
  principal: ReturnType<AgentService['rootPrincipal']>,
  runId: string,
  status: string,
) {
  for (let i = 0; i < 200; i++) {
    const run = service.getRun(principal, runId)
    if (run.status === status) return run
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`run ${runId} did not reach ${status}`)
}

describe('AgentService', () => {
  test('writes the terminal chat-list summary inside Card Kit config', async () => {
    const settings: object[] = []
    const { service, root } = harness({
      patchSettingsChecked: async (_cardId, value) => { settings.push(value); return true },
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'summary test' })
    await waitFor(service, root, started.runId, 'completed')
    expect(settings.at(-1)).toEqual({
      config: {
        streaming_mode: false,
        summary: { content: '✅ agent · 1/1 · depth 0' },
      },
    })
  })

  test('runs several full Agents concurrently and persists native sessions', async () => {
    const { service, root, artifacts, textArtifacts } = harness({ identities: [identity('a'), identity('codex')] })
    const started = await service.startRun(root, { identityIds: ['agent:a', 'agent:codex'], prompt: 'implement' })
    const terminal = await waitFor(service, root, started.runId, 'completed')
    expect(terminal.workers.map(worker => worker.sessionId)).toEqual(['sid-agent:a', 'sid-agent:codex'])
    expect(artifacts.length).toBeGreaterThan(1)
    expect(textArtifacts.size).toBe(3)
    expect((artifacts.at(-1) as any).workers.every((worker: any) => worker.output === '')).toBe(true)
  })

  test('bridges needs_input to an exact answer and resumes the same process', async () => {
    let resolve!: (value: AgentWorkerResult) => void
    let pending: any = null
    const { service, root } = harness({
      startWorker: opts => {
        const done = new Promise<AgentWorkerResult>(ok => { resolve = ok })
        queueMicrotask(() => {
          pending = { requestId: 'req-1', questions: [{ id: 'q1', question: 'Proceed?', options: [] }] }
          opts.callbacks?.onNeedsInput?.(pending)
        })
        return {
          done,
          pendingInput: () => pending,
          answer(requestId, answers) {
            expect(requestId).toBe('req-1')
            expect(answers).toEqual({ q1: 'yes' })
            pending = null
            resolve(result('sid-input'))
          },
          async cancel() {},
        }
      },
    })
    const started = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'ask if needed' })
    await waitFor(service, root, started.runId, 'needs_input')
    await service.answer(root, started.runId, { requestId: 'req-1', answers: { q1: 'yes' } })
    const terminal = await waitFor(service, root, started.runId, 'completed')
    expect(terminal.workers[0].sessionId).toBe('sid-input')
  })

  test('follows up through the same provider-native session', async () => {
    const calls: Array<{ prompt: string; resume?: string }> = []
    const { service, root } = harness({
      startWorker: opts => {
        calls.push({ prompt: opts.prompt, resume: opts.resumeSessionId })
        return resolvedHandle(result(opts.resumeSessionId ?? 'sid-first', opts.prompt))
      },
    })
    const first = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'first' })
    await waitFor(service, root, first.runId, 'completed')
    const follow = await service.followUp(root, first.runId, { prompt: 'second' })
    await waitFor(service, root, follow.runId, 'completed')
    expect(calls).toEqual([{ prompt: 'first', resume: undefined }, { prompt: 'second', resume: 'sid-first' }])
  })

  test('scopes child capabilities to a run subtree and recursively cancels descendants', async () => {
    const controls: ReturnType<typeof controlledHandle>[] = []
    const capabilities: string[] = []
    const { service, root } = harness({
      startWorker: opts => {
        capabilities.push(String(opts.hostEnv.LODESTAR_AGENT_CAPABILITY))
        const control = controlledHandle()
        controls.push(control)
        return control.handle
      },
    })
    const parent = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'parent' })
    for (let i = 0; i < 50 && !capabilities[0]; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const childPrincipal = service.principalForCapability(capabilities[0])!
    await expect(service.cancelRun(childPrincipal, parent.runId, 'self-cancel')).rejects.toThrow('containing run')
    const child = await service.startRun(childPrincipal, { identityIds: ['agent:a'], prompt: 'child' })
    expect(child.parentRunId).toBe(parent.runId)
    expect(child.depth).toBe(1)
    await service.cancelRun(root, parent.runId, 'stop tree')
    expect(service.getRun(root, parent.runId).status).toBe('cancelled')
    expect(service.getRun(root, child.runId).status).toBe('cancelled')
  })

  test('marks interrupted durable runs failed on daemon restart', () => {
    const active = {
      runId: 'agent_old', sessionName: 'project', chatId: 'chat-1', workDir: '/repo', prompt: 'old', depth: 0,
      status: 'running' as const, createdAt: new Date().toISOString(), workers: [{
        identityId: 'agent:a', identityName: 'A', tokenSourceId: 'a', provider: 'claude' as const,
        model: 'm', effort: 'max', status: 'running' as const, output: '', steps: [],
      }],
    }
    const { service, root } = harness({ loadArtifacts: () => [active] })
    expect(service.getRun(root, 'agent_old')).toMatchObject({ status: 'failed', error: expect.stringContaining('daemon restarted') })
  })

  test('invalidates a root run whose card was opening when the Session was cancelled', async () => {
    let cardEntered!: () => void
    let releaseCard!: () => void
    const entered = new Promise<void>(resolve => { cardEntered = resolve })
    const released = new Promise<void>(resolve => { releaseCard = resolve })
    let starts = 0
    const { service, root } = harness({
      sendCard: async () => { cardEntered(); await released; return 'message-root-race' },
      startWorker: opts => { starts++; return resolvedHandle(result(`sid-${opts.identity.id}`)) },
    })
    const creating = service.startRun(root, { identityIds: ['agent:a'], prompt: 'racing root' })
    await entered
    await service.cancelSessionRuns('project', 'chat-1', 'session stop')
    releaseCard()
    const run = await creating
    expect(run.status).toBe('cancelled')
    expect(starts).toBe(0)
  })

  test('seals a parent capability before awaiting kill and cancels an in-flight child creation', async () => {
    const parentControl = controlledHandle()
    let capability = ''
    let starts = 0
    let childCardEntered!: () => void
    let releaseChildCard!: () => void
    const childEntered = new Promise<void>(resolve => { childCardEntered = resolve })
    const childReleased = new Promise<void>(resolve => { releaseChildCard = resolve })
    let cards = 0
    const { service, root } = harness({
      sendCard: async () => {
        cards++
        if (cards === 1) return 'message-parent'
        childCardEntered()
        await childReleased
        return 'message-child'
      },
      startWorker: opts => {
        starts++
        capability = String(opts.hostEnv.LODESTAR_AGENT_CAPABILITY)
        return parentControl.handle
      },
    })
    const parent = await service.startRun(root, { identityIds: ['agent:a'], prompt: 'parent' })
    for (let i = 0; i < 50 && !capability; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const childPrincipal = service.principalForCapability(capability)!
    const creatingChild = service.startRun(childPrincipal, { identityIds: ['agent:a'], prompt: 'racing child' })
    await childEntered
    await service.cancelRun(root, parent.runId, 'stop parent')
    expect(service.principalForCapability(capability)).toBeNull()
    releaseChildCard()
    const child = await creatingChild
    expect(child.status).toBe('cancelled')
    expect(starts).toBe(1)
  })

  test('rejects unbounded queued workers before sending another card', async () => {
    const identities = Array.from({ length: 64 }, (_, index) => identity(`q${index}`))
    let cards = 0
    const controls: ReturnType<typeof controlledHandle>[] = []
    const { service, root } = harness({
      identities,
      sendCard: async () => { cards++; return `message-${cards}` },
      startWorker: () => {
        const control = controlledHandle()
        controls.push(control)
        return control.handle
      },
    })
    const ids = identities.map(item => item.id)
    await service.startRun(root, { identityIds: ids, prompt: 'batch one' })
    await service.startRun(root, { identityIds: ids, prompt: 'batch two' })
    await expect(service.startRun(root, { identityIds: [ids[0]], prompt: 'overflow' }))
      .rejects.toThrow('global Agent worker limit')
    expect(cards).toBe(2)
    await service.shutdown('test cleanup')
  })
})
