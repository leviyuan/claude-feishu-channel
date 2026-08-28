import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session } from './session'
import type { ConsultService } from './consult-service'
import { getConsultIdentityCatalog } from './consult-identities'
import { parseConsultRunRequest } from './consult-types'
import type { ConsultRunSnapshot } from './consult-types'
import { pendingTokenSourceModelRefresh } from './token-source'

const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface ConsultApiContext {
  service: ConsultService
  authorize(capability: string): Session | null
}

export async function handleConsultRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: ConsultApiContext,
): Promise<boolean> {
  if (url.pathname !== '/consult' && !url.pathname.startsWith('/consult/')) return false
  const send = (status: number, value: object): true => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
    return true
  }
  const capability = bearerToken(req.headers.authorization)
  if (!capability) return send(401, { error: 'missing bearer capability' })
  const session = context.authorize(capability)
  if (!session) return send(403, { error: 'invalid or stale consult capability' })

  if (req.method === 'GET' && url.pathname === '/consult/identities') {
    await pendingTokenSourceModelRefresh()
    return send(200, serializeCatalog(getConsultIdentityCatalog()))
  }
  if (req.method === 'POST' && url.pathname === '/consult/runs') {
    let request
    try {
      request = parseConsultRunRequest(await readJsonBody(req))
    } catch (error) {
      return send(400, { error: messageOf(error) })
    }
    try {
      const run = await context.service.startRun(session, request)
      return send(202, serializeRun(run))
    } catch (error) {
      return send(409, { error: messageOf(error) })
    }
  }
  const match = url.pathname.match(/^\/consult\/runs\/([^/]+)$/)
  if (match && req.method === 'GET') {
    const runId = decodeRunId(match[1])
    if (!runId) return send(400, { error: 'invalid consult run id encoding' })
    const run = context.service.getRun(runId)
    if (!run || !context.service.ownsRun(runId, session)) return send(404, { error: 'consult run not found' })
    return send(200, serializeRun(run))
  }
  if (match && req.method === 'DELETE') {
    const runId = decodeRunId(match[1])
    if (!runId) return send(400, { error: 'invalid consult run id encoding' })
    const run = context.service.getRun(runId)
    if (!run || !context.service.ownsRun(runId, session)) return send(404, { error: 'consult run not found' })
    const cancelled = await context.service.cancelRun(runId, 'cancelled by consult client')
    return send(cancelled ? 200 : 409, cancelled
      ? { ok: true, run_id: runId }
      : { error: 'consult run is already terminal', run_id: runId })
  }
  return send(405, { error: 'unsupported consult endpoint' })
}

function decodeRunId(value: string): string | null {
  try { return decodeURIComponent(value) }
  catch { return null }
}

function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? ''
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  try { return JSON.parse(raw || '{}') }
  catch { throw new Error('bad json') }
}

function serializeCatalog(catalog: ReturnType<typeof getConsultIdentityCatalog>): object {
  return {
    catalog_generation: catalog.catalogGeneration,
    identities: catalog.identities.map(identity => ({
      id: identity.id,
      display_name: identity.displayName,
      token_source_id: identity.tokenSourceId,
      token_source_display: identity.tokenSourceDisplay,
      provider: identity.provider,
      model: identity.model,
      model_display: identity.modelDisplay,
      effort: identity.effort,
      supported_efforts: identity.supportedEfforts,
      source_default: identity.sourceDefault,
      origin: identity.origin,
      status: identity.status,
      reason: identity.reason,
      role: identity.role,
      instructions: identity.instructions,
      base_identity_id: identity.baseIdentityId,
    })),
    source_failures: catalog.sourceFailures.map(failure => ({
      token_source_id: failure.tokenSourceId,
      display: failure.display,
      status: failure.status,
      reason: failure.reason,
    })),
    ...(catalog.presetFailure ? { preset_failure: catalog.presetFailure } : {}),
  }
}

function serializeRun(run: ConsultRunSnapshot): object {
  return {
    run_id: run.runId,
    session_name: run.sessionName,
    kind: run.kind,
    target: run.target,
    question: run.question,
    instructions: run.instructions,
    cross_review: run.crossReview,
    status: run.status,
    target_fingerprint: run.targetFingerprint,
    reviewers: run.reviewers.map(reviewer => ({
      identity_id: reviewer.identityId,
      identity_name: reviewer.identityName,
      token_source_id: reviewer.tokenSourceId,
      model: reviewer.model,
      effort: reviewer.effort,
      status: reviewer.status,
      output: reviewer.output,
      first_pass_output: reviewer.firstPassOutput,
      error: reviewer.error,
      started_at: reviewer.startedAt,
      finished_at: reviewer.finishedAt,
      duration_ms: reviewer.durationMs,
      usage: reviewer.usage,
    })),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
    error: run.error,
    card_message_id: run.cardMessageId,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
