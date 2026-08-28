export type ConsultKind = 'question' | 'review' | 'critique'

export type ConsultTarget =
  | { type: 'working_directory' }
  | { type: 'uncommitted_changes' }
  | { type: 'commit'; sha: string }
  | { type: 'base_branch'; branch: string }
  | { type: 'proposal'; text: string }

export interface ConsultRunRequest {
  identityIds: string[]
  kind: ConsultKind
  target?: ConsultTarget
  question?: string
  instructions?: string
  crossReview?: boolean
}

export type ConsultReviewerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ConsultRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ConsultReviewerResult {
  identityId: string
  identityName: string
  tokenSourceId: string
  model: string
  effort: string
  status: ConsultReviewerStatus
  output: string
  firstPassOutput?: string
  error?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  usage?: Record<string, number | undefined> | null
}

export interface ConsultRunSnapshot {
  runId: string
  sessionName: string
  kind: ConsultKind
  target: ConsultTarget
  question: string
  instructions: string
  crossReview: boolean
  status: ConsultRunStatus
  targetFingerprint: string
  reviewers: ConsultReviewerResult[]
  createdAt: string
  finishedAt?: string
  error?: string
  cardMessageId?: string
}

export function parseConsultRunRequest(raw: unknown): ConsultRunRequest {
  if (!raw || typeof raw !== 'object') throw new Error('consult request must be an object')
  const value = raw as Record<string, unknown>
  const identityIds = Array.isArray(value.identity_ids)
    ? value.identity_ids.map(String)
    : Array.isArray(value.identityIds)
      ? value.identityIds.map(String)
      : []
  const normalizedIds = [...new Set(identityIds.map(id => id.trim()).filter(Boolean))]
  if (normalizedIds.length === 0) throw new Error('consult request requires at least one identity_id')
  if (normalizedIds.length > 64) throw new Error('consult request supports at most 64 identities')
  const kind = String(value.kind ?? '') as ConsultKind
  if (kind !== 'question' && kind !== 'review' && kind !== 'critique') {
    throw new Error(`unsupported consult kind: ${String(value.kind ?? '')}`)
  }
  const question = String(value.question ?? '').trim()
  const instructions = String(value.instructions ?? '').trim()
  const target = parseConsultTarget(value.target)
  if (kind === 'question' && !question) throw new Error('question consult requires "question"')
  if (kind === 'critique' && !question && target.type !== 'proposal') {
    throw new Error('critique consult requires "question" or a proposal target')
  }
  const crossReview = value.cross_review === true || value.crossReview === true
  if (crossReview && normalizedIds.length > 8) throw new Error('cross-review supports at most 8 identities')
  return {
    identityIds: normalizedIds,
    kind,
    target,
    question,
    instructions,
    crossReview,
  }
}

function parseConsultTarget(raw: unknown): ConsultTarget {
  if (raw === undefined || raw === null) return { type: 'working_directory' }
  if (!raw || typeof raw !== 'object') throw new Error('consult target must be an object')
  const value = raw as Record<string, unknown>
  const type = String(value.type ?? '')
  switch (type) {
    case 'working_directory': return { type }
    case 'uncommitted_changes': return { type }
    case 'commit': {
      const sha = String(value.sha ?? '').trim()
      if (!sha) throw new Error('commit target requires sha')
      return { type, sha }
    }
    case 'base_branch': {
      const branch = String(value.branch ?? '').trim()
      if (!branch) throw new Error('base_branch target requires branch')
      return { type, branch }
    }
    case 'proposal': {
      const text = String(value.text ?? '')
      if (!text.trim()) throw new Error('proposal target requires text')
      return { type, text }
    }
    default: throw new Error(`unsupported consult target: ${type || 'MISS'}`)
  }
}
