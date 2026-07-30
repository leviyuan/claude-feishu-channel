import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DATA_DIR, TASKLIST_MAP_FILE } from './paths'
import * as feishu from './feishu'
import { log } from './log'

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
}

const bindings = new Map<string, TasklistBinding>()

loadTasklistMap()

export function tasklistNameForProject(projectName: string): string {
  return `${projectName}[lodestar]`
}

export function getTasklistBinding(projectName: string): TasklistBinding | null {
  return bindings.get(projectName) ?? null
}

export function listTasklistBindings(): TasklistBinding[] {
  return [...bindings.values()].map(cloneBinding)
}

export function updateTasklistBinding(projectName: string, update: (binding: TasklistBinding) => void): TasklistBinding {
  const binding = bindings.get(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
  update(binding)
  normalizeBinding(projectName, binding)
  saveTasklistMap()
  return cloneBinding(binding)
}

export async function enableTasklist(projectName: string, chatId: string): Promise<TasklistBinding> {
  const existing = getTasklistBinding(projectName)
  if (existing) return ensureTasklistSections(projectName)

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
  bindings.set(projectName, binding)
  saveTasklistMap()
  await ensureTasklistSections(projectName)
  saveTasklistMap()
  return cloneBinding(binding)
}

export async function ensureTasklistSections(projectName: string): Promise<TasklistBinding> {
  const binding = getTasklistBinding(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
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
  binding.sections = sections
  saveTasklistMap()
  return cloneBinding(binding)
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
  const binding = getTasklistBinding(projectName)
  if (!binding) throw new Error('tasklist is not enabled')
  if (binding.guid !== expectedGuid) {
    throw new Error(`tasklist binding changed: current=${binding.guid} requested=${expectedGuid}`)
  }
  await feishu.deleteTasklistByGuid(binding.guid)
  bindings.delete(projectName)
  saveTasklistMap()
  return cloneBinding(binding)
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
      }
      normalizeBinding(projectName, binding)
      bindings.set(projectName, binding)
    }
    log(`tasklist: loaded ${bindings.size} project bindings`)
  } catch (e) {
    log(`tasklist: load map failed: ${e}`)
  }
}

function saveTasklistMap(): void {
  try {
    const obj: Record<string, TasklistBinding> = {}
    for (const [projectName, binding] of bindings) obj[projectName] = cloneBinding(binding)
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(TASKLIST_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) {
    log(`tasklist: save map failed: ${e}`)
  }
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
    if (typeof obj[spec.key] === 'string' && obj[spec.key]) out[spec.key] = obj[spec.key]
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
  }
}
