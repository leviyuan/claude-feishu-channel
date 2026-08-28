import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { getConsultIdentityCatalog, type ConsultIdentity } from './consult-identities'
import { startConsultWorker, buildConsultPrompt, type ConsultWorkerHandle } from './consult-runner'
import { buildConsultTargetContext, type ConsultTargetContext } from './consult-target'
import type {
  ConsultReviewerResult,
  ConsultRunRequest,
  ConsultRunSnapshot,
  ConsultRunStatus,
} from './consult-types'
import { CONSULT_RUNS_DIR } from './paths'
import { writeJsonStateAtomic } from './state-store'
import { log } from './log'
import type { Session } from './session'

const CONSULT_CONCURRENCY = 4

interface ActiveConsultRun {
  snapshot: ConsultRunSnapshot
  targetContext: ConsultTargetContext
  identities: ConsultIdentity[]
  workDir: string
  chatId: string
  cardId: string
  workers: Map<string, ConsultWorkerHandle>
  cancelled: boolean
  terminalized: boolean
  finalized: boolean
  presentationErrors: string[]
}

export interface ConsultServiceDeps {
  getCatalog: typeof getConsultIdentityCatalog
  startWorker: typeof startConsultWorker
  buildTargetContext: typeof buildConsultTargetContext
  sendCard(chatId: string, card: object): Promise<string | null>
  sendTextRaw(chatId: string, text: string): Promise<unknown>
  convertMessageToCard(messageId: string): Promise<string>
  recordCardCreated(cardId: string, elementCount: number, onFailure?: (code?: number) => void): void
  replaceElementChecked(cardId: string, elementId: string, element: object): Promise<boolean>
  patchSummaryThrottled(cardId: string, summary: string): void
  flush(cardId: string): Promise<void>
  cancelSummary(cardId: string): void
  patchSettingsChecked(cardId: string, settings: object): Promise<boolean>
  dispose(cardId: string): Promise<void>
  writeArtifact(path: string, value: unknown): void
}

const DEFAULT_DEPS: ConsultServiceDeps = {
  getCatalog: getConsultIdentityCatalog,
  startWorker: startConsultWorker,
  buildTargetContext: buildConsultTargetContext,
  sendCard: feishu.sendCard,
  sendTextRaw: feishu.sendTextRaw,
  convertMessageToCard: cardkit.convertMessageToCard,
  recordCardCreated: cardkit.recordCardCreated,
  replaceElementChecked: cardkit.replaceElementChecked,
  patchSummaryThrottled: cardkit.patchSummaryThrottled,
  flush: cardkit.flush,
  cancelSummary: cardkit.cancelSummary,
  patchSettingsChecked: cardkit.patchSettingsChecked,
  dispose: cardkit.dispose,
  writeArtifact: writeJsonStateAtomic,
}

export class ConsultService {
  private readonly runs = new Map<string, ActiveConsultRun>()
  /** Synchronous pre-await reservations close the startRun TOCTOU window while
   * the Feishu card is being created and converted. */
  private readonly startingRunsByChat = new Map<string, string>()

  constructor(private readonly deps: ConsultServiceDeps = DEFAULT_DEPS) {}

  async startRun(session: Session, request: ConsultRunRequest): Promise<ConsultRunSnapshot> {
    this.pruneRuns()
    const runId = `consult_${randomUUID()}`
    const startingRunId = this.startingRunsByChat.get(session.chatId)
    const existing = [...this.runs.values()].find(run =>
      run.chatId === session.chatId && !run.finalized)
    if (startingRunId || existing) {
      throw new Error(
        `consult run already active: ${startingRunId ?? existing!.snapshot.runId}; batch all identities into one run with repeated --identity flags`,
      )
    }
    this.startingRunsByChat.set(session.chatId, runId)
    try {
      const catalog = this.deps.getCatalog()
      const identities = request.identityIds.map(id => {
        const identity = catalog.identities.find(item => item.id === id)
        if (!identity) throw new Error(`consult identity not found: ${id}`)
        if (identity.status !== 'ready') throw new Error(`${identity.displayName}: ${identity.reason ?? identity.status}`)
        return identity
      })
      const target = request.target ?? { type: 'working_directory' as const }
      const targetContext = await this.deps.buildTargetContext(session.workDir, target)
      const snapshot: ConsultRunSnapshot = {
        runId,
        sessionName: session.sessionName,
        kind: request.kind,
        target,
        question: request.question ?? '',
        instructions: request.instructions ?? '',
        crossReview: request.crossReview === true,
        status: 'running',
        targetFingerprint: targetContext.fingerprint,
        reviewers: identities.map(identity => reviewerSnapshot(identity)),
        createdAt: new Date().toISOString(),
      }
      const messageId = await this.deps.sendCard(session.chatId, cards.consultRunCard(snapshot))
      if (!messageId) throw new Error('consult card creation failed; reviewers were not started')
      let cardId: string
      try {
        cardId = await this.deps.convertMessageToCard(messageId)
      } catch (error) {
        await this.deps.sendTextRaw(session.chatId, `❌ consult 卡片初始化失败，reviewer 未启动: ${messageOf(error)}`)
        throw error
      }
      snapshot.cardMessageId = messageId
      this.deps.recordCardCreated(cardId, snapshot.reviewers.length + 2, code => {
        log(`consult: card write failed run=${runId} code=${code ?? 'MISS'}`)
      })
      const run: ActiveConsultRun = {
        snapshot,
        targetContext,
        identities,
        workDir: session.workDir,
        chatId: session.chatId,
        cardId,
        workers: new Map(),
        cancelled: false,
        terminalized: false,
        finalized: false,
        presentationErrors: [],
      }
      this.runs.set(runId, run)
      void this.executeRun(run).catch(async error => {
        log(`consult: run=${runId} crashed: ${messageOf(error)}`)
        await this.finishRun(run, 'failed', messageOf(error))
      })
      return cloneSnapshot(snapshot)
    } finally {
      if (this.startingRunsByChat.get(session.chatId) === runId) {
        this.startingRunsByChat.delete(session.chatId)
      }
    }
  }

  getRun(runId: string): ConsultRunSnapshot | null {
    this.pruneRuns()
    const run = this.runs.get(runId)
    if (!run) return null
    const snapshot = cloneSnapshot(run.snapshot)
    // A terminal API response means reviewer output, durable artifact, and
    // card diagnostics have all settled. Keep polling clients in `running`
    // while the final transaction is still being closed.
    if (run.terminalized && !run.finalized) {
      snapshot.status = 'running'
      delete snapshot.finishedAt
    }
    return snapshot
  }

  ownsRun(runId: string, session: Session): boolean {
    const run = this.runs.get(runId)
    return !!run && run.snapshot.sessionName === session.sessionName && run.chatId === session.chatId
  }

  async cancelRun(runId: string, reason = 'consult cancelled'): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run || run.snapshot.status !== 'running' || run.terminalized) return false
    run.cancelled = true
    const workers = [...run.workers.values()]
    await Promise.allSettled(workers.map(worker => worker.cancel(reason)))
    for (const reviewer of run.snapshot.reviewers) {
      if (reviewer.status === 'queued' || reviewer.status === 'running') {
        reviewer.status = 'cancelled'
        reviewer.error = reason
        reviewer.finishedAt = new Date().toISOString()
      }
    }
    await this.finishRun(run, 'cancelled', reason)
    return true
  }

  async cancelSessionRuns(sessionName: string, chatId: string, reason: string): Promise<void> {
    const active = [...this.runs.values()]
      .filter(run => run.snapshot.sessionName === sessionName && run.chatId === chatId
        && run.snapshot.status === 'running' && !run.terminalized)
    await Promise.allSettled(active.map(run => this.cancelRun(run.snapshot.runId, reason)))
  }

  private pruneRuns(): void {
    if (this.runs.size <= 256) return
    const terminal = [...this.runs.values()]
      .filter(run => run.finalized)
      .sort((a, b) => Date.parse(a.snapshot.finishedAt ?? a.snapshot.createdAt) - Date.parse(b.snapshot.finishedAt ?? b.snapshot.createdAt))
    for (const run of terminal) {
      if (this.runs.size <= 256) break
      this.runs.delete(run.snapshot.runId)
    }
  }

  private async executeRun(run: ActiveConsultRun): Promise<void> {
    await this.executeRound(run, false)
    if (run.cancelled || run.snapshot.status !== 'running') return
    const firstPassFailed = run.snapshot.reviewers.some(item => item.status !== 'completed')
    if (firstPassFailed) {
      await this.finishRun(run, 'failed', '一个或多个选定顾问失败，未进入后续复核')
      return
    }
    if (run.snapshot.crossReview && run.snapshot.reviewers.length > 1) {
      for (const reviewer of run.snapshot.reviewers) {
        reviewer.firstPassOutput = reviewer.output
        reviewer.output = ''
        reviewer.status = 'queued'
        reviewer.error = undefined
        reviewer.startedAt = undefined
        reviewer.finishedAt = undefined
        reviewer.durationMs = undefined
      }
      await Promise.all(run.snapshot.reviewers.map(reviewer => this.updateReviewerCard(run, reviewer)))
      await this.executeRound(run, true)
      if (run.cancelled || run.snapshot.status !== 'running') return
      if (run.snapshot.reviewers.some(item => item.status !== 'completed')) {
        await this.finishRun(run, 'failed', '交叉复核未全部完成')
        return
      }
    }
    const latestTarget = await this.deps.buildTargetContext(run.workDir, run.snapshot.target)
    if (latestTarget.fingerprint !== run.snapshot.targetFingerprint) {
      await this.finishRun(run, 'failed', '评审期间目标已变化，结果已标记为过期')
      return
    }
    await this.finishRun(run, 'completed')
  }

  private async executeRound(run: ActiveConsultRun, crossReview: boolean): Promise<void> {
    const peerSource = run.snapshot.reviewers.map(item => ({
      identityId: item.identityId,
      name: item.identityName,
      output: item.firstPassOutput ?? item.output,
    }))
    await mapWithConcurrency(run.identities, CONSULT_CONCURRENCY, async identity => {
      const reviewer = run.snapshot.reviewers.find(item => item.identityId === identity.id)!
      if (run.cancelled) return
      let worker: ConsultWorkerHandle
      try {
        const prompt = buildConsultPrompt({
          identity,
          kind: run.snapshot.kind,
          question: run.snapshot.question,
          instructions: run.snapshot.instructions,
          targetContext: run.targetContext.promptContext,
          ...(crossReview ? {
            peerOutputs: peerSource
              .filter(peer => peer.identityId !== identity.id)
              .map(peer => ({ name: peer.name, output: peer.output })),
          } : {}),
        })
        worker = this.deps.startWorker({ identity, workDir: run.workDir, prompt })
      } catch (error) {
        await this.failReviewer(run, reviewer, messageOf(error))
        return
      }
      run.workers.set(identity.id, worker)
      if (run.cancelled) {
        await worker.cancel('consult cancelled before reviewer start')
        run.workers.delete(identity.id)
        return
      }
      reviewer.status = 'running'
      reviewer.startedAt = new Date().toISOString()
      await this.updateReviewerCard(run, reviewer)
      try {
        const result = await worker.done
        if (run.cancelled) return
        reviewer.status = 'completed'
        reviewer.output = result.output
        reviewer.durationMs = result.durationMs
        reviewer.usage = result.usage
        reviewer.finishedAt = new Date().toISOString()
        await this.updateReviewerCard(run, reviewer)
      } catch (error) {
        if (run.cancelled) return
        await this.failReviewer(run, reviewer, messageOf(error))
      } finally {
        run.workers.delete(identity.id)
      }
    })
  }

  private async failReviewer(run: ActiveConsultRun, reviewer: ConsultReviewerResult, error: string): Promise<void> {
    reviewer.status = 'failed'
    reviewer.error = error
    reviewer.finishedAt = new Date().toISOString()
    if (reviewer.startedAt) reviewer.durationMs = Date.now() - Date.parse(reviewer.startedAt)
    await this.updateReviewerCard(run, reviewer)
  }

  private async updateReviewerCard(run: ActiveConsultRun, reviewer: ConsultReviewerResult): Promise<void> {
    try {
      const landed = await this.deps.replaceElementChecked(
        run.cardId,
        cards.consultReviewerElementId(reviewer.identityId),
        cards.consultReviewerElement(reviewer),
      )
      if (!landed) this.recordPresentationError(run, `reviewer card MISS: ${reviewer.identityName}`)
    } catch (error) {
      this.recordPresentationError(
        run,
        `reviewer card update failed (${reviewer.identityName}): ${messageOf(error)}`,
      )
    }
    try {
      this.deps.patchSummaryThrottled(run.cardId, cards.consultRunSummary(run.snapshot))
    } catch (error) {
      this.recordPresentationError(run, `reviewer summary update failed: ${messageOf(error)}`)
    }
  }

  private async finishRun(run: ActiveConsultRun, status: ConsultRunStatus, error?: string): Promise<void> {
    if (run.terminalized) return
    run.terminalized = true
    try {
      run.snapshot.status = status
      run.snapshot.finishedAt = new Date().toISOString()
      if (error) appendSnapshotError(run.snapshot, error)
      if (run.presentationErrors.length) {
        for (const detail of run.presentationErrors) appendSnapshotError(run.snapshot, detail)
      }
      try {
        this.deps.writeArtifact(join(CONSULT_RUNS_DIR, `${run.snapshot.runId}.json`), run.snapshot)
      } catch (persistError) {
        const detail = messageOf(persistError)
        run.snapshot.status = 'failed'
        appendSnapshotError(run.snapshot, `artifact persistence failed: ${detail}`)
        log(`consult: run artifact persistence failed run=${run.snapshot.runId}: ${detail}`)
      }
      let diagnosticsChanged = false
      try {
        await this.deps.flush(run.cardId)
        const footer = await this.deps.replaceElementChecked(
          run.cardId,
          cards.ELEMENTS.consultRunFooter,
          cards.consultRunFooterElement(run.snapshot),
        )
        this.deps.cancelSummary(run.cardId)
        const settings = await this.deps.patchSettingsChecked(run.cardId, cards.streamingOffSettings({
          suffix: run.snapshot.status === 'completed'
            ? '✅ 咨询完成'
            : run.snapshot.status === 'cancelled'
              ? '🛑 咨询取消'
              : '❌ 咨询失败',
        }))
        if (footer && settings) {
          await this.deps.dispose(run.cardId)
        } else {
          const detail = `footer=${footer ? 'ok' : 'MISS'} settings=${settings ? 'ok' : 'MISS'}`
          appendSnapshotError(run.snapshot, `card finalization failed: ${detail}`)
          diagnosticsChanged = true
          log(`consult: terminal card transaction MISS run=${run.snapshot.runId} ${detail}`)
          if (!await this.sendWarning(run, `⚠️ consult ${run.snapshot.runId} 结果已产生，但卡片未能正常收尾 (${detail})`)) {
            diagnosticsChanged = true
          }
        }
      } catch (presentationError) {
        const detail = messageOf(presentationError)
        appendSnapshotError(run.snapshot, `card finalization failed: ${detail}`)
        diagnosticsChanged = true
        log(`consult: terminal card finalization crashed run=${run.snapshot.runId}: ${detail}`)
        if (!await this.sendWarning(run, `⚠️ consult ${run.snapshot.runId} 结果已产生，但卡片收尾失败: ${detail}`)) {
          diagnosticsChanged = true
        }
      }
      if (run.presentationErrors.length) {
        if (!await this.sendWarning(
          run,
          `⚠️ consult ${run.snapshot.runId} 完整结果已返回主 Agent，但 ${run.presentationErrors.length} 次评审卡更新未落地。`,
        )) diagnosticsChanged = true
      }
      if (diagnosticsChanged) {
        try { this.deps.writeArtifact(join(CONSULT_RUNS_DIR, `${run.snapshot.runId}.json`), run.snapshot) }
        catch (persistError) {
          const detail = messageOf(persistError)
          run.snapshot.status = 'failed'
          appendSnapshotError(run.snapshot, `artifact diagnostic persistence failed: ${detail}`)
          log(`consult: failed to persist final diagnostics run=${run.snapshot.runId}: ${detail}`)
        }
      }
    } catch (unexpectedError) {
      const detail = messageOf(unexpectedError)
      run.snapshot.status = 'failed'
      appendSnapshotError(run.snapshot, `terminal finalization crashed: ${detail}`)
      log(`consult: unexpected terminal finalization crash run=${run.snapshot.runId}: ${detail}`)
      try { this.deps.writeArtifact(join(CONSULT_RUNS_DIR, `${run.snapshot.runId}.json`), run.snapshot) }
      catch (persistError) { log(`consult: failed to persist terminal crash run=${run.snapshot.runId}: ${messageOf(persistError)}`) }
    } finally {
      run.finalized = true
    }
  }

  private recordPresentationError(run: ActiveConsultRun, detail: string): void {
    run.presentationErrors.push(detail)
    log(`consult: ${detail} run=${run.snapshot.runId}`)
  }

  private async sendWarning(run: ActiveConsultRun, text: string): Promise<boolean> {
    try {
      await this.deps.sendTextRaw(run.chatId, text)
      return true
    } catch (error) {
      const detail = `warning delivery failed: ${messageOf(error)}`
      appendSnapshotError(run.snapshot, detail)
      log(`consult: ${detail} run=${run.snapshot.runId}`)
      return false
    }
  }
}

function reviewerSnapshot(identity: ConsultIdentity): ConsultReviewerResult {
  return {
    identityId: identity.id,
    identityName: identity.displayName,
    tokenSourceId: identity.tokenSourceId,
    model: identity.model,
    effort: identity.effort,
    status: 'queued',
    output: '',
  }
}

function cloneSnapshot(snapshot: ConsultRunSnapshot): ConsultRunSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ConsultRunSnapshot
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendSnapshotError(snapshot: ConsultRunSnapshot, detail: string): void {
  snapshot.error = [snapshot.error, detail].filter(Boolean).join('; ')
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const current = index++
      if (current >= values.length) return
      await run(values[current])
    }
  })
  await Promise.all(workers)
}
