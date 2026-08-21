import { existsSync, readFileSync } from 'node:fs'
import { TASKLIST_MAP_FILE } from './paths'
import * as feishu from './feishu'
import { log } from './log'
import { writeJsonStateAtomic } from './state-store'

export type TasklistSectionKey = 'design' | 'aiTodo' | 'aiDoing' | 'aiReview' | 'done'

export interface TasklistSectionSpec {
  key: TasklistSectionKey
  name: string
}

export const TASKLIST_SECTION_SPECS: TasklistSectionSpec[] = [
  { key: 'design', name: '设计中' },
  { key: 'aiTodo', name: '[AI]待执行' },
  { key: 'aiDoing', name: '[AI]执行中' },
  { key: 'aiReview', name: '[AI]待审核' },
  { key: 'done', name: '已完成' },
]

export const TASKLIST_CUSTOM_SECTION_SPECS: TasklistSectionSpec[] = TASKLIST_SECTION_SPECS
  .filter(spec => spec.key !== 'design')

export type TasklistSectionMap = Partial<Record<TasklistSectionKey, string>>

export interface TaskAutomationRunRef {
  runId: string
  fingerprint?: string
  status?: AutomationProcessRecord['status']
  commentId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface TaskAutomationState {
  guid: string
  summary?: string
  sectionKey?: TasklistSectionKey
  completedAt?: string
  updatedAt?: string
  lastSeenAt?: string
  lastDesignFingerprint?: string
  codexPlan?: TaskAutomationRunRef
  agyPlan?: TaskAutomationRunRef
  agyPick?: TaskAutomationRunRef
  codexExecution?: TaskAutomationRunRef
  agyReview?: TaskAutomationRunRef
  codexMerge?: TaskAutomationRunRef
  executionBranch?: string
  executionTag?: string
  reviewBranch?: string
  reviewRef?: string
  errorCommentIds?: string[]
  lastError?: string
}

export interface AutomationProcessRecord {
  runId: string
  projectName: string
  tasklistGuid: string
  taskGuid?: string
  kind:
    | 'codex-plan'
    | 'agy-plan'
    | 'agy-pick'
    | 'codex-execute'
    | 'agy-review'
    | 'codex-merge'
  pid?: number
  pgid?: number
  command: string[]
  cwd: string
  status: 'running' | 'exited' | 'failed'
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  signal?: string | null
  stdoutTail?: string
  stderrTail?: string
  error?: string
  treeCleanupWarning?: string
}

export interface TasklistWorkerState {
  lastScanAt?: string
  lastScanError?: string
  runningTaskGuid?: string
  /** 上次 ensureTasklistSections(section 结构自愈)的时间戳。section guid 稳态不变,
   *  没必要每个 worker tick 都 listTasklistSections + getTasklistSection 校验一遍 ——
   *  worker 用这个字段做时间窗,默认 30min 才自愈一次(见 tasklist-worker.ts)。 */
  lastSectionEnsureAt?: string
}

export interface TasklistDeletionState {
  requestedAt: string
  lastAttemptAt?: string
  attempts: number
  lastError?: string
}

export interface TasklistBinding {
  guid: string
  name: string
  url: string
  projectName: string
  ownerOpenId: string
  createdAt?: string
  sections?: TasklistSectionMap
  tasks?: Record<string, TaskAutomationState>
  processes?: Record<string, AutomationProcessRecord>
  worker?: TasklistWorkerState
  /** Durable delete intent. The worker reconciles these tombstones before it
   * starts normal scans, so a crash after the remote DELETE cannot resurrect
   * an apparently healthy local binding. */
  deleting?: TasklistDeletionState
}

const bindings = new Map<string, TasklistBinding>()
const lifecycleTails = new Map<string, Promise<void>>()

loadTasklistMap()

export function tasklistNameForProject(projectName: string): string {
  return `${projectName}[lodestar]`
}

export function getTasklistBinding(projectName: string): TasklistBinding | null {
  const binding = bindings.get(projectName)
  return binding ? cloneBinding(binding) : null
}

export function listTasklistBindings(): TasklistBinding[] {
  return [...bindings.values()].map(cloneBinding)
}

export function updateTasklistBinding(projectName: string, update: (binding: TasklistBinding) => void): TasklistBinding {
  const binding = bindings.get(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
  const nextBinding = cloneBinding(binding)
  update(nextBinding)
  normalizeBinding(projectName, nextBinding)
  commitBinding(projectName, nextBinding)
  return cloneBinding(nextBinding)
}

/** Serialize remote create/delete lifecycles per project. Different projects
 * remain concurrent; repeated card clicks for one project cannot create two
 * tasklists or interleave enable with deletion. Exported for focused tests. */
export async function withTasklistLifecycleLock<T>(projectName: string, run: () => Promise<T>): Promise<T> {
  const previous = lifecycleTails.get(projectName) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  lifecycleTails.set(projectName, tail)
  await previous.catch(() => {})
  try {
    return await run()
  } finally {
    release()
    if (lifecycleTails.get(projectName) === tail) lifecycleTails.delete(projectName)
  }
}

export function markTasklistDeleting(binding: TasklistBinding, now = new Date().toISOString()): void {
  binding.deleting ??= { requestedAt: now, attempts: 0 }
}

/** Feishu Task v2's exact "resource not found" code. A durable deletion may
 * legitimately see this after the remote DELETE committed but the daemon
 * crashed before removing its local tombstone. No other error is swallowed. */
export function isTasklistAlreadyDeletedError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 1470404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\bcode=1470404\b/.test(message)
}

export async function deleteTasklistRemoteIdempotently(
  guid: string,
  deleteRemote: (guid: string) => Promise<void> = feishu.deleteTasklistByGuid,
): Promise<'deleted' | 'already_deleted'> {
  try {
    await deleteRemote(guid)
    return 'deleted'
  } catch (e) {
    if (isTasklistAlreadyDeletedError(e)) return 'already_deleted'
    throw e
  }
}

export function mergeEnsuredTasklistSections(
  binding: TasklistBinding,
  expectedGuid: string,
  sections: TasklistSectionMap,
): void {
  if (binding.guid !== expectedGuid) {
    throw new Error(`tasklist binding changed while ensuring sections: current=${binding.guid} expected=${expectedGuid}`)
  }
  if (binding.deleting) throw new Error(`tasklist deletion is pending for ${binding.projectName}`)
  binding.sections = { ...sections }
}

export async function enableTasklist(projectName: string, chatId: string): Promise<TasklistBinding> {
  return await withTasklistLifecycleLock(projectName, () => enableTasklistUnlocked(projectName, chatId))
}

async function enableTasklistUnlocked(projectName: string, chatId: string): Promise<TasklistBinding> {
  const existing = getTasklistBinding(projectName)
  if (existing?.deleting) throw new Error(`tasklist deletion is pending for ${projectName}`)
  if (existing) return ensureTasklistSectionsUnlocked(projectName)

  const name = tasklistNameForProject(projectName)
  if (name.length > 100) throw new Error(`tasklist name is too long (${name.length}/100): ${name}`)

  const ownerOpenId = await feishu.fetchChatOwnerOpenId(chatId)
  const tasklist = await feishu.createTasklistWithOwner(name, ownerOpenId)

  const binding: TasklistBinding = {
    guid: tasklist.guid,
    name: tasklist.name,
    url: tasklist.url,
    projectName,
    ownerOpenId,
    createdAt: tasklist.createdAt,
    sections: {},
    tasks: {},
    processes: {},
    worker: {},
  }
  commitBinding(projectName, binding)
  await ensureTasklistSectionsUnlocked(projectName)
  return getTasklistBinding(projectName)!
}

export async function ensureTasklistSections(projectName: string): Promise<TasklistBinding> {
  return await withTasklistLifecycleLock(projectName, () => ensureTasklistSectionsUnlocked(projectName))
}

async function ensureTasklistSectionsUnlocked(projectName: string): Promise<TasklistBinding> {
  const binding = getTasklistBinding(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
  if (binding.deleting) throw new Error(`tasklist deletion is pending for ${projectName}`)
  let existing = await feishu.listTasklistSections(binding.guid)
  existing = await removeEmptyLegacyDesignSections(existing)
  const byName = new Map(existing.map(section => [section.name, section.guid]))
  const sections: TasklistSectionMap = { ...(binding.sections ?? {}) }
  sections.design = await ensureDefaultDesignSection(binding.guid, sections.design)
  let insertAfter: string | undefined
  for (const spec of TASKLIST_CUSTOM_SECTION_SPECS) {
    const guid = byName.get(spec.name) ?? await createSection(binding.guid, spec.name, insertAfter)
    sections[spec.key] = guid
    insertAfter = guid
  }
  // Merge only the remotely-derived section field into the latest durable
  // binding. `binding` is a pre-await snapshot; committing it wholesale would
  // erase process/task updates that landed while Feishu calls were in flight.
  return updateTasklistBinding(projectName, latest => {
    mergeEnsuredTasklistSections(latest, binding.guid, sections)
  })
}

async function ensureDefaultDesignSection(tasklistGuid: string, storedGuid?: string): Promise<string> {
  const designName = sectionNameForKey('design')
  let section: feishu.TasklistSection | null = null
  if (storedGuid) {
    const stored = await feishu.getTasklistSection(storedGuid)
    if (stored.tasklistGuid && stored.tasklistGuid !== tasklistGuid) {
      throw new Error(`stored design section ${storedGuid} belongs to tasklist ${stored.tasklistGuid}, expected ${tasklistGuid}`)
    }
    if (stored.isDefault) section = stored
    else log(`tasklist: ignore non-default stored design section ${storedGuid}`)
  }
  if (!section) {
    const guid = await feishu.discoverTasklistDefaultSectionGuid(tasklistGuid)
    section = await feishu.getTasklistSection(guid)
    if (section.tasklistGuid && section.tasklistGuid !== tasklistGuid) {
      throw new Error(`discovered design section ${guid} belongs to tasklist ${section.tasklistGuid}, expected ${tasklistGuid}`)
    }
    if (!section.isDefault) throw new Error(`discovered design section is not default: ${guid}`)
  }
  if (section.name !== designName) {
    section = await feishu.patchTasklistSectionName(section.guid, designName)
    if (!section.isDefault) throw new Error(`renamed design section is not default: ${section.guid}`)
  }
  return section.guid
}

async function removeEmptyLegacyDesignSections(
  sections: feishu.TasklistSection[],
): Promise<feishu.TasklistSection[]> {
  const out: feishu.TasklistSection[] = []
  const designName = sectionNameForKey('design')
  for (const section of sections) {
    if (section.isDefault || section.name !== designName) {
      out.push(section)
      continue
    }
    const tasks = await feishu.listSectionTasks(section.guid)
    if (tasks.length > 0) {
      log(`tasklist: keep non-empty legacy design section ${section.guid} tasks=${tasks.length}`)
      out.push(section)
      continue
    }
    await feishu.deleteTasklistSection(section.guid)
    log(`tasklist: deleted empty legacy design section ${section.guid}`)
  }
  return out
}

export async function deleteTasklist(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  return await withTasklistLifecycleLock(projectName, () => deleteTasklistUnlocked(projectName, expectedGuid))
}

async function deleteTasklistUnlocked(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  const binding = getTasklistBinding(projectName)
  if (!binding) throw new Error('tasklist is not enabled')
  if (binding.guid !== expectedGuid) {
    throw new Error(`tasklist binding changed: current=${binding.guid} requested=${expectedGuid}`)
  }
  if (!binding.deleting) {
    updateTasklistBinding(projectName, next => markTasklistDeleting(next))
  }
  return await finishTasklistDeletion(projectName, expectedGuid)
}

async function finishTasklistDeletion(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  const attempting = updateTasklistBinding(projectName, binding => {
    if (binding.guid !== expectedGuid) {
      throw new Error(`tasklist binding changed during deletion: current=${binding.guid} expected=${expectedGuid}`)
    }
    markTasklistDeleting(binding)
    binding.deleting!.attempts++
    binding.deleting!.lastAttemptAt = new Date().toISOString()
    binding.deleting!.lastError = undefined
  })
  try {
    const remoteResult = await deleteTasklistRemoteIdempotently(expectedGuid)
    if (remoteResult === 'already_deleted') {
      log(`tasklist: ${projectName} remote list ${expectedGuid} is already deleted (code=1470404); finishing tombstone`)
    }
    const latest = bindings.get(projectName)
    if (!latest || latest.guid !== expectedGuid || !latest.deleting) {
      throw new Error(`tasklist deletion state changed before local commit: ${projectName}`)
    }
    const next = new Map(bindings)
    next.delete(projectName)
    saveTasklistMap(next)
    bindings.delete(projectName)
    return cloneBinding(attempting)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    try {
      updateTasklistBinding(projectName, binding => {
        if (binding.guid === expectedGuid && binding.deleting) binding.deleting.lastError = error
      })
    } catch (persistError) {
      log(`tasklist: failed to persist delete error for ${projectName}: ${persistError}`)
    }
    throw e
  }
}

/** Retry durable delete intents at worker startup. A failed retry leaves the
 * tombstone in place and is surfaced to the caller; normal scans must skip it. */
export async function reconcileTasklistDeletions(): Promise<void> {
  const pending = [...bindings.entries()]
    .filter(([, binding]) => !!binding.deleting)
    .map(([projectName, binding]) => ({ projectName, guid: binding.guid }))
  const failures: string[] = []
  for (const item of pending) {
    try {
      await withTasklistLifecycleLock(item.projectName, () => finishTasklistDeletion(item.projectName, item.guid))
      log(`tasklist: reconciled pending deletion for ${item.projectName}`)
    } catch (e) {
      failures.push(`${item.projectName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length > 0) throw new Error(`tasklist deletion reconcile failed: ${failures.join('; ')}`)
}

export function taskStateFor(binding: TasklistBinding, taskGuid: string): TaskAutomationState {
  binding.tasks ??= {}
  const state = binding.tasks[taskGuid] ?? { guid: taskGuid }
  binding.tasks[taskGuid] = state
  return state
}

export function sectionKeyForGuid(binding: TasklistBinding, sectionGuid: string): TasklistSectionKey | null {
  const sections = binding.sections ?? {}
  for (const spec of TASKLIST_SECTION_SPECS) {
    if (sections[spec.key] === sectionGuid) return spec.key
  }
  return null
}

export function sectionNameForKey(key: TasklistSectionKey): string {
  return TASKLIST_SECTION_SPECS.find(spec => spec.key === key)?.name ?? key
}

function createSection(tasklistGuid: string, name: string, insertAfter?: string): Promise<string> {
  return feishu.createTasklistSection({
    tasklistGuid,
    name,
    insertAfter,
  })
}

function loadTasklistMap(): void {
  if (!existsSync(TASKLIST_MAP_FILE)) return
  try {
    const obj = JSON.parse(readFileSync(TASKLIST_MAP_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object') return
    for (const [projectName, raw] of Object.entries(obj)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Partial<TasklistBinding>
      if (typeof item.guid !== 'string' || !item.guid) continue
      if (typeof item.name !== 'string' || !item.name) continue
      const binding: TasklistBinding = {
        guid: item.guid,
        name: item.name,
        url: typeof item.url === 'string' ? item.url : '',
        projectName,
        ownerOpenId: typeof item.ownerOpenId === 'string' ? item.ownerOpenId : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        sections: readSectionMap(item.sections),
        tasks: readTasks(item.tasks),
        processes: readProcesses(item.processes),
        worker: readWorker(item.worker),
        deleting: readDeleting(item.deleting),
      }
      normalizeBinding(projectName, binding)
      bindings.set(projectName, binding)
    }
    log(`tasklist: loaded ${bindings.size} project bindings`)
  } catch (e) {
    log(`tasklist: load map failed: ${e}`)
  }
}

function commitBinding(projectName: string, binding: TasklistBinding): void {
  const next = new Map(bindings)
  next.set(projectName, cloneBinding(binding))
  saveTasklistMap(next)
  bindings.set(projectName, binding)
}

function saveTasklistMap(source: Map<string, TasklistBinding> = bindings): void {
  const obj: Record<string, TasklistBinding> = {}
  for (const [projectName, binding] of source) obj[projectName] = cloneBinding(binding)
  // Persistence is part of the state transition: callers must observe a
  // failed write instead of reporting success with an unrecoverable in-memory
  // state. The shared store keeps the previous valid snapshot until rename.
  writeJsonStateAtomic(TASKLIST_MAP_FILE, obj)
}

function normalizeBinding(projectName: string, binding: TasklistBinding): void {
  binding.projectName = projectName
  binding.sections ??= {}
  binding.tasks ??= {}
  binding.processes ??= {}
  binding.worker ??= {}
}

function cloneBinding(binding: TasklistBinding): TasklistBinding {
  return JSON.parse(JSON.stringify(binding)) as TasklistBinding
}

function readSectionMap(raw: unknown): TasklistSectionMap {
  const out: TasklistSectionMap = {}
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const spec of TASKLIST_SECTION_SPECS) {
    const value = obj[spec.key]
    if (typeof value === 'string' && value) out[spec.key] = value
  }
  return out
}

function readTasks(raw: unknown): Record<string, TaskAutomationState> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, TaskAutomationState> = {}
  for (const [guid, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const task = value as Partial<TaskAutomationState>
    out[guid] = {
      ...task,
      guid,
    }
  }
  return out
}

function readProcesses(raw: unknown): Record<string, AutomationProcessRecord> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, AutomationProcessRecord> = {}
  for (const [runId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const process = value as Partial<AutomationProcessRecord>
    if (typeof process.projectName !== 'string') continue
    if (typeof process.tasklistGuid !== 'string') continue
    if (!Array.isArray(process.command)) continue
    if (typeof process.cwd !== 'string') continue
    out[runId] = {
      runId,
      projectName: process.projectName,
      tasklistGuid: process.tasklistGuid,
      taskGuid: typeof process.taskGuid === 'string' ? process.taskGuid : undefined,
      kind: process.kind ?? 'agy-plan',
      pid: typeof process.pid === 'number' ? process.pid : undefined,
      pgid: typeof process.pgid === 'number' ? process.pgid : undefined,
      command: process.command.map(String),
      cwd: process.cwd,
      status: process.status ?? 'failed',
      startedAt: typeof process.startedAt === 'string' ? process.startedAt : new Date().toISOString(),
      finishedAt: typeof process.finishedAt === 'string' ? process.finishedAt : undefined,
      exitCode: typeof process.exitCode === 'number' || process.exitCode === null ? process.exitCode : undefined,
      signal: typeof process.signal === 'string' || process.signal === null ? process.signal : undefined,
      stdoutTail: typeof process.stdoutTail === 'string' ? process.stdoutTail : undefined,
      stderrTail: typeof process.stderrTail === 'string' ? process.stderrTail : undefined,
      error: typeof process.error === 'string' ? process.error : undefined,
      treeCleanupWarning: typeof process.treeCleanupWarning === 'string' ? process.treeCleanupWarning : undefined,
    }
  }
  return out
}

function readWorker(raw: unknown): TasklistWorkerState {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Partial<TasklistWorkerState>
  return {
    lastScanAt: typeof obj.lastScanAt === 'string' ? obj.lastScanAt : undefined,
    lastScanError: typeof obj.lastScanError === 'string' ? obj.lastScanError : undefined,
    runningTaskGuid: typeof obj.runningTaskGuid === 'string' ? obj.runningTaskGuid : undefined,
    lastSectionEnsureAt: typeof obj.lastSectionEnsureAt === 'string' ? obj.lastSectionEnsureAt : undefined,
  }
}

function readDeleting(raw: unknown): TasklistDeletionState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Partial<TasklistDeletionState>
  if (typeof obj.requestedAt !== 'string' || !obj.requestedAt) return undefined
  return {
    requestedAt: obj.requestedAt,
    lastAttemptAt: typeof obj.lastAttemptAt === 'string' ? obj.lastAttemptAt : undefined,
    attempts: typeof obj.attempts === 'number' && Number.isFinite(obj.attempts) && obj.attempts >= 0
      ? Math.floor(obj.attempts)
      : 0,
    lastError: typeof obj.lastError === 'string' ? obj.lastError : undefined,
  }
}
