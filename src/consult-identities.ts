import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { CONSULT_IDENTITIES_FILE } from './paths'
import { log } from './log'
import { listTokenSources, type TokenSource, type TokenSourceModel } from './token-source'
import { writeJsonStateAtomic } from './state-store'
import type { AgentProvider, AgentReasoningEffort } from './agent-process'
import { CONSULT_ROLES, roleInstructions, roleLabel, type ConsultRole } from './consult-roles'
export { CONSULT_ROLES, roleInstructions, roleLabel, type ConsultRole } from './consult-roles'
export type ConsultIdentityOrigin = 'catalog' | 'preset'
export type ConsultIdentityStatus =
  | 'ready'
  | 'source_disabled'
  | 'catalog_loading'
  | 'catalog_failed'
  | 'effort_unsupported'
  | 'base_missing'
  | 'preset_disabled'

export interface ConsultIdentity {
  id: string
  displayName: string
  tokenSourceId: string
  tokenSourceDisplay: string
  provider: AgentProvider
  model: string
  modelDisplay: string
  effort: AgentReasoningEffort
  supportedEfforts: AgentReasoningEffort[]
  sourceDefault: boolean
  origin: ConsultIdentityOrigin
  status: ConsultIdentityStatus
  reason?: string
  role: ConsultRole
  instructions?: string
  baseIdentityId?: string
  spawnRevision?: string
}

export interface ConsultSourceFailure {
  tokenSourceId: string
  display: string
  status: 'disabled' | 'loading' | 'failed' | 'models_miss'
  reason: string
}

export interface ConsultIdentityCatalog {
  catalogGeneration: string
  identities: ConsultIdentity[]
  sourceFailures: ConsultSourceFailure[]
  presetFailure?: string
}

export interface ConsultIdentityPreset {
  id: string
  name: string
  baseIdentityId: string
  role: ConsultRole
  instructions?: string
  effort?: AgentReasoningEffort
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface ConsultIdentityStore {
  version: 1
  presets: ConsultIdentityPreset[]
}

let store: ConsultIdentityStore = { version: 1, presets: [] }
let storeLoadError: string | null = null
const AGENT_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
loadStore()

export function catalogIdentityId(tokenSourceId: string, model: string): string {
  const encoded = Buffer.from(`${tokenSourceId}\u0000${model}`, 'utf8').toString('base64url')
  return `catalog:${encoded}`
}

export function getConsultIdentityCatalog(): ConsultIdentityCatalog {
  return buildConsultIdentityCatalog(listTokenSources(), store.presets, storeLoadError)
}

export function buildConsultIdentityCatalog(
  sources: TokenSource[],
  presets: ConsultIdentityPreset[] = [],
  presetFailure: string | null = null,
): ConsultIdentityCatalog {
  const identities: ConsultIdentity[] = []
  const sourceFailures: ConsultSourceFailure[] = []
  for (const source of sources) {
    collectSourceCatalog(source, identities, sourceFailures)
  }
  const baseById = new Map(identities.map(identity => [identity.id, identity]))
  for (const preset of presets) identities.push(materializePreset(preset, baseById.get(preset.baseIdentityId)))
  const generation = createHash('sha256')
    .update(JSON.stringify({ identities, sourceFailures, presetFailure }))
    .digest('hex')
    .slice(0, 16)
  return {
    catalogGeneration: generation,
    identities,
    sourceFailures,
    ...(presetFailure ? { presetFailure } : {}),
  }
}

export function getConsultIdentity(id: string): ConsultIdentity | null {
  return getConsultIdentityCatalog().identities.find(identity => identity.id === id) ?? null
}

export function listConsultIdentityPresets(): ConsultIdentityPreset[] {
  return store.presets.map(clonePreset)
}

export function createConsultIdentityPreset(
  baseIdentityId: string,
  role: ConsultRole,
  effort: AgentReasoningEffort = 'max',
): ConsultIdentityPreset {
  if (storeLoadError) throw new Error(`consult identity store is unavailable: ${storeLoadError}`)
  if (!CONSULT_ROLES.includes(role)) throw new Error(`unsupported consult role: ${role}`)
  const base = getConsultIdentityCatalog().identities.find(identity => identity.origin === 'catalog' && identity.id === baseIdentityId)
  if (!base) throw new Error(`base consult identity not found: ${baseIdentityId}`)
  if (store.presets.some(preset =>
    preset.baseIdentityId === baseIdentityId && preset.role === role && (preset.effort ?? 'max') === effort)) {
    throw new Error(`consult identity preset already exists: ${roleLabel(role)} · ${base.modelDisplay}`)
  }
  const now = new Date().toISOString()
  const preset: ConsultIdentityPreset = {
    id: `preset:${randomUUID()}`,
    name: `${roleLabel(role)} · ${base.modelDisplay}`,
    baseIdentityId,
    role,
    effort,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  const nextStore: ConsultIdentityStore = { version: 1, presets: [...store.presets, preset] }
  saveStore(nextStore)
  store = nextStore
  return clonePreset(preset)
}

export function toggleConsultIdentityPreset(id: string): ConsultIdentityPreset {
  if (storeLoadError) throw new Error(`consult identity store is unavailable: ${storeLoadError}`)
  const index = store.presets.findIndex(preset => preset.id === id)
  if (index < 0) throw new Error(`consult identity preset not found: ${id}`)
  const next = clonePreset(store.presets[index])
  next.enabled = !next.enabled
  next.updatedAt = new Date().toISOString()
  const presets = store.presets.map((preset, i) => i === index ? next : preset)
  const nextStore: ConsultIdentityStore = { version: 1, presets }
  saveStore(nextStore)
  store = nextStore
  return clonePreset(next)
}

export function deleteConsultIdentityPreset(id: string): void {
  if (storeLoadError) throw new Error(`consult identity store is unavailable: ${storeLoadError}`)
  const presets = store.presets.filter(preset => preset.id !== id)
  if (presets.length === store.presets.length) throw new Error(`consult identity preset not found: ${id}`)
  const nextStore: ConsultIdentityStore = { version: 1, presets }
  saveStore(nextStore)
  store = nextStore
}

export function resetConsultIdentityStoreForTest(next: ConsultIdentityPreset[] = []): void {
  store = { version: 1, presets: next.map(clonePreset) }
  storeLoadError = null
}

function collectSourceCatalog(
  source: TokenSource,
  identities: ConsultIdentity[],
  failures: ConsultSourceFailure[],
): void {
  const catalogState = source.modelCatalogState?.status
    ?? (!source.enabled ? 'disabled' : source.models.length > 0 ? 'ready' : 'idle')
  if (!source.enabled) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'disabled', reason: '账号未启用' })
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'loading', reason: '模型目录正在刷新' })
  } else if (catalogState === 'failed') {
    failures.push({
      tokenSourceId: source.id,
      display: source.display,
      status: 'failed',
      reason: source.modelCatalogState?.error ?? '模型目录刷新失败',
    })
  } else if (source.models.length === 0) {
    failures.push({ tokenSourceId: source.id, display: source.display, status: 'models_miss', reason: '模型目录为空' })
  }
  for (const model of source.models) identities.push(materializeCatalogIdentity(source, model, catalogState))
}

function materializeCatalogIdentity(
  source: TokenSource,
  model: TokenSourceModel,
  catalogState: string,
): ConsultIdentity {
  let status: ConsultIdentityStatus = 'ready'
  let reason: string | undefined
  if (!source.enabled) {
    status = 'source_disabled'
    reason = '所属 Token Source 未启用'
  } else if (catalogState === 'loading' || catalogState === 'idle') {
    status = 'catalog_loading'
    reason = '模型目录正在刷新'
  } else if (catalogState === 'failed') {
    status = 'catalog_failed'
    reason = source.modelCatalogState?.error ?? '模型目录刷新失败'
  } else if (!model.efforts.includes('max')) {
    status = 'effort_unsupported'
    reason = '该模型不支持 max effort'
  }
  return {
    id: catalogIdentityId(source.id, model.model),
    displayName: `${source.display} · ${model.display}`,
    tokenSourceId: source.id,
    tokenSourceDisplay: source.display,
    provider: source.agent,
    model: model.model,
    modelDisplay: model.display,
    effort: 'max',
    supportedEfforts: [...model.efforts],
    sourceDefault: comparableModel(source.defaultModel) === comparableModel(model.model),
    origin: 'catalog',
    status,
    ...(reason ? { reason } : {}),
    role: 'general',
    instructions: roleInstructions('general'),
    spawnRevision: source.spawnRevision,
  }
}

function comparableModel(value: string): string {
  return value.replace(/\[1m\]$/i, '').toLowerCase()
}

function materializePreset(preset: ConsultIdentityPreset, base: ConsultIdentity | undefined): ConsultIdentity {
  if (!base) {
    return {
      id: preset.id,
      displayName: preset.name,
      tokenSourceId: '',
      tokenSourceDisplay: 'MISS',
      provider: 'codex',
      model: '',
      modelDisplay: 'MISS',
      effort: preset.effort ?? 'max',
      supportedEfforts: [],
      sourceDefault: false,
      origin: 'preset',
      status: 'base_missing',
      reason: '底层模型身份已不存在',
      role: preset.role,
      instructions: [roleInstructions(preset.role), preset.instructions].filter(Boolean).join('\n'),
      baseIdentityId: preset.baseIdentityId,
    }
  }
  const effort = preset.effort ?? 'max'
  let status = base.status
  let reason = base.reason
  if (!preset.enabled) {
    status = 'preset_disabled'
    reason = '全局身份已停用'
  } else if (!base.supportedEfforts.includes(effort)) {
    status = 'effort_unsupported'
    reason = `该模型不支持 ${effort} effort`
  }
  return {
    ...base,
    id: preset.id,
    displayName: preset.name,
    effort,
    origin: 'preset',
    status,
    ...(reason ? { reason } : {}),
    role: preset.role,
    instructions: [roleInstructions(preset.role), preset.instructions].filter(Boolean).join('\n'),
    baseIdentityId: preset.baseIdentityId,
  }
}

function loadStore(): void {
  if (!existsSync(CONSULT_IDENTITIES_FILE)) return
  try {
    const raw = JSON.parse(readFileSync(CONSULT_IDENTITIES_FILE, 'utf8'))
    if (!raw || raw.version !== 1 || !Array.isArray(raw.presets)) throw new Error('invalid version or presets array')
    const presets: ConsultIdentityPreset[] = []
    for (const item of raw.presets) {
      if (!item || typeof item !== 'object') throw new Error('invalid preset entry')
      if (typeof item.id !== 'string' || !item.id.startsWith('preset:')) throw new Error('invalid preset id')
      if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`invalid preset name: ${item.id}`)
      if (typeof item.baseIdentityId !== 'string' || !item.baseIdentityId) throw new Error(`invalid base identity: ${item.id}`)
      if (!CONSULT_ROLES.includes(item.role)) throw new Error(`invalid role: ${item.id}`)
      presets.push({
        id: item.id,
        name: item.name,
        baseIdentityId: item.baseIdentityId,
        role: item.role,
        instructions: typeof item.instructions === 'string' ? item.instructions : undefined,
        effort: item.effort === undefined
          ? undefined
          : typeof item.effort === 'string' && AGENT_EFFORTS.has(item.effort)
            ? item.effort as AgentReasoningEffort
            : (() => { throw new Error(`invalid effort: ${item.id}`) })(),
        enabled: item.enabled !== false,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
      })
    }
    store = { version: 1, presets }
  } catch (error) {
    storeLoadError = error instanceof Error ? error.message : String(error)
    log(`consult identities: load failed: ${storeLoadError}`)
  }
}

function saveStore(value: ConsultIdentityStore): void {
  writeJsonStateAtomic(CONSULT_IDENTITIES_FILE, value)
}

function clonePreset(preset: ConsultIdentityPreset): ConsultIdentityPreset {
  return JSON.parse(JSON.stringify(preset)) as ConsultIdentityPreset
}
