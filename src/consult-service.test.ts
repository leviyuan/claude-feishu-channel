import { describe, expect, test } from 'bun:test'
import { ConsultService, type ConsultServiceDeps } from './consult-service'
import type { ConsultIdentity, ConsultIdentityCatalog } from './consult-identities'
import type { ConsultWorkerHandle } from './consult-runner'

function identity(id: string, model: string): ConsultIdentity {
  return {
    id, displayName: model, tokenSourceId: id, tokenSourceDisplay: id,
    provider: 'claude', model, modelDisplay: model, effort: 'max',
    supportedEfforts: ['max'], sourceDefault: true, origin: 'catalog',
    status: 'ready', role: 'general', instructions: '独立评估',
  }
}

function harness(opts: {
  identities?: ConsultIdentity[]
  startWorker?: ConsultServiceDeps['startWorker']
  buildTargetContext?: ConsultServiceDeps['buildTargetContext']
  writeArtifact?: ConsultServiceDeps['writeArtifact']
  replaceElementChecked?: ConsultServiceDeps['replaceElementChecked']
  patchSettingsChecked?: ConsultServiceDeps['patchSettingsChecked']
  sendTextRaw?: ConsultServiceDeps['sendTextRaw']
  sendCard?: ConsultServiceDeps['sendCard']
} = {}) {
  const identities = opts.identities ?? [identity('a', 'Model-A')]
  const prompts: string[] = []
  const artifacts: unknown[] = []
  const catalog: ConsultIdentityCatalog = {
    catalogGeneration: 'g1', identities, sourceFailures: [],
  }
  const deps: ConsultServiceDeps = {
    getCatalog: () => catalog,
    startWorker: opts.startWorker ?? (workerOpts => {
      prompts.push(workerOpts.prompt)
      return {
        done: Promise.resolve({ output: `answer-${workerOpts.identity.id}`, durationMs: 5, usage: null }),
        cancel: async () => {},
      }
    }),
    buildTargetContext: opts.buildTargetContext ?? (async (_cwd, target) => ({ target, fingerprint: 'f1', promptContext: 'target context' })),
    sendCard: opts.sendCard ?? (async () => 'message-1'),
    sendTextRaw: opts.sendTextRaw ?? (async () => true),
    convertMessageToCard: async () => 'card-1',
    recordCardCreated: () => {},
    replaceElementChecked: opts.replaceElementChecked ?? (async () => true),
    patchSummaryThrottled: () => {},
    flush: async () => {},
    cancelSummary: () => {},
    patchSettingsChecked: opts.patchSettingsChecked ?? (async () => true),
    dispose: async () => {},
    writeArtifact: opts.writeArtifact ?? ((_path, value) => { artifacts.push(value) }),
  }
  return { service: new ConsultService(deps), prompts, artifacts }
}

const session = {
  sessionName: 'project', chatId: 'chat-1', workDir: '/repo',
} as any

async function waitTerminal(service: ConsultService, runId: string) {
  for (let i = 0; i < 50; i++) {
    const run = service.getRun(runId)!
    if (run.status !== 'running') return run
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('consult run did not settle')
}

describe('ConsultService', () => {
  test('runs selected identities in parallel and persists a terminal report', async () => {
    const { service, artifacts } = harness({ identities: [identity('a', 'A'), identity('b', 'B')] })
    const started = await service.startRun(session, {
      identityIds: ['a', 'b'], kind: 'question', question: 'why?',
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('completed')
    expect(run.reviewers.map(item => item.output)).toEqual(['answer-a', 'answer-b'])
    expect(artifacts).toHaveLength(1)
  })

  test('performs exactly one cross-review round with peer outputs', async () => {
    const identities = [identity('a', 'A'), identity('b', 'B')]
    const prompts: string[] = []
    const { service } = harness({
      identities,
      startWorker: opts => {
        prompts.push(opts.prompt)
        const round = prompts.filter(prompt => prompt.includes(`身份: ${opts.identity.displayName}`)).length
        return {
          done: Promise.resolve({ output: `${opts.identity.id}-round-${round}`, durationMs: 1, usage: null }),
          cancel: async () => {},
        }
      },
    })
    const started = await service.startRun(session, {
      identityIds: ['a', 'b'], kind: 'review', target: { type: 'proposal', text: 'plan' }, crossReview: true,
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('completed')
    expect(prompts).toHaveLength(4)
    expect(prompts.slice(2).every(prompt => prompt.includes('其他顾问首轮结果'))).toBe(true)
    expect(run.reviewers.every(item => !!item.firstPassOutput)).toBe(true)
  })

  test('keeps partial reviewer failure visible and does not report success', async () => {
    const { service } = harness({
      identities: [identity('a', 'A'), identity('b', 'B')],
      startWorker: opts => ({
        done: opts.identity.id === 'b'
          ? Promise.reject(new Error('upstream unavailable'))
          : Promise.resolve({ output: 'ok', durationMs: 1, usage: null }),
        cancel: async () => {},
      }),
    })
    const started = await service.startRun(session, {
      identityIds: ['a', 'b'], kind: 'question', question: 'check',
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('failed')
    expect(run.reviewers.find(item => item.identityId === 'b')).toMatchObject({
      status: 'failed', error: 'upstream unavailable',
    })
  })

  test('bounds reviewer process concurrency while preserving every selected identity', async () => {
    const identities = Array.from({ length: 5 }, (_, index) => identity(`id-${index}`, `M${index}`))
    const resolvers: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const { service } = harness({
      identities,
      startWorker: opts => ({
        done: new Promise(resolve => {
          active++
          maxActive = Math.max(maxActive, active)
          resolvers.push(() => {
            active--
            resolve({ output: `ok-${opts.identity.id}`, durationMs: 1, usage: null })
          })
        }),
        cancel: async () => {},
      }),
    })
    const started = await service.startRun(session, {
      identityIds: identities.map(item => item.id), kind: 'question', question: 'fanout',
    })
    for (let i = 0; i < 20 && resolvers.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolvers).toHaveLength(4)
    resolvers.splice(0, 4).forEach(resolve => resolve())
    for (let i = 0; i < 20 && resolvers.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolvers).toHaveLength(1)
    resolvers.shift()!()
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('completed')
    expect(maxActive).toBe(4)
  })

  test('marks otherwise successful results failed when the target changes', async () => {
    let reads = 0
    const { service } = harness({
      buildTargetContext: async (_cwd, target) => ({
        target,
        fingerprint: ++reads === 1 ? 'before' : 'after',
        promptContext: 'target context',
      }),
    })
    const started = await service.startRun(session, {
      identityIds: ['a'], kind: 'review', target: { type: 'uncommitted_changes' },
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('目标已变化')
  })

  test('surfaces report persistence failure as a failed run', async () => {
    const { service } = harness({
      writeArtifact: () => { throw new Error('disk full') },
    })
    const started = await service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'check',
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('disk full')
  })

  test('keeps reviewer results when an incremental card update throws', async () => {
    let updates = 0
    const { service } = harness({
      replaceElementChecked: async () => {
        if (++updates === 1) throw new Error('card queue unavailable')
        return true
      },
    })
    const started = await service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'check',
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('completed')
    expect(run.reviewers[0].output).toBe('answer-a')
    expect(run.error).toContain('card queue unavailable')
  })

  test('surfaces final card and warning delivery failures without hanging the run', async () => {
    const { service } = harness({
      patchSettingsChecked: async () => false,
      sendTextRaw: async () => { throw new Error('Feishu unavailable') },
    })
    const started = await service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'check',
    })
    const run = await waitTerminal(service, started.runId)
    expect(run.status).toBe('completed')
    expect(run.error).toContain('card finalization failed')
    expect(run.error).toContain('warning delivery failed')
  })

  test('cancels exact active workers for a session', async () => {
    let rejectDone!: (error: Error) => void
    let cancelled = 0
    const pending = new Promise<any>((_resolve, reject) => { rejectDone = reject })
    const worker: ConsultWorkerHandle = {
      done: pending,
      cancel: async reason => { cancelled++; rejectDone(new Error(reason)) },
    }
    const { service } = harness({ startWorker: () => worker })
    const started = await service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'wait',
    })
    for (let i = 0; i < 20 && service.getRun(started.runId)?.reviewers[0].status !== 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await service.cancelSessionRuns('project', 'chat-1', 'stop')
    expect(cancelled).toBe(1)
    expect(service.getRun(started.runId)?.status).toBe('cancelled')
  })

  test('allows only one active consultation per project-group session', async () => {
    let rejectDone!: (error: Error) => void
    const worker: ConsultWorkerHandle = {
      done: new Promise((_resolve, reject) => { rejectDone = reject }),
      cancel: async reason => { rejectDone(new Error(reason)) },
    }
    const { service } = harness({ startWorker: () => worker })
    const first = await service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'first',
    })
    await expect(service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'second',
    })).rejects.toThrow('already active')
    await service.cancelRun(first.runId, 'done')
  })

  test('atomically rejects concurrent starts while the first card is still opening', async () => {
    let releaseCard!: () => void
    let cardStarted!: () => void
    const cardEntered = new Promise<void>(resolve => { cardStarted = resolve })
    const cardRelease = new Promise<void>(resolve => { releaseCard = resolve })
    const { service } = harness({
      sendCard: async () => {
        cardStarted()
        await cardRelease
        return 'message-1'
      },
    })
    const first = service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'first',
    })
    await cardEntered
    await expect(service.startRun(session, {
      identityIds: ['a'], kind: 'question', question: 'racing second',
    })).rejects.toThrow('already active')
    releaseCard()
    const started = await first
    await waitTerminal(service, started.runId)
  })
})
