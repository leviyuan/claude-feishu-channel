import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { buildAgySpawnPath, resolveAgyBin, agyPrintArgs } from './agy-task'
import { resolveCodexBin } from './codex-process'
import * as feishu from './feishu'
import { log } from './log'
import * as tasklist from './tasklist'
import {
  AI_AUTO_BRANCH,
  AI_REVIEW_BRANCH,
  assertTaskArtifactTagAvailable,
  createTaskArtifactTag,
  git,
  isReviewHeadMerged,
  localReviewRef,
  prepareAutomationWorktree,
  reviewDiffSpec,
  reviewHeadRef,
  taskArtifactTag,
} from './tasklist-worker-git'
export { localReviewRef, reviewDiffSpec, reviewHeadRef, taskArtifactTag } from './tasklist-worker-git'
import type {
  AutomationProcessRecord,
  TaskAutomationRunRef,
  TaskAutomationState,
  TasklistBinding,
  TasklistSectionKey,
} from './tasklist'

const TASKLIST_WORKER_INTERVAL_MS = 5 * 60 * 1000
const TASKLIST_WORKER_BOOT_DELAY_MS = 15_000
/** ensureTasklistSections(section 结构自愈)的最小间隔。section guid 稳态不变,每个
 *  worker tick 都 listTasklistSections + getTasklistSection 校验纯属空转打 task v2 API。
 *  30min 自愈一次足够:section 被人手删的故障窗口最多 30min,换来 API 调用大幅下降。 */
const SECTION_ENSURE_INTERVAL_MS = 30 * 60 * 1000
const PROCESS_OUTPUT_TAIL_LIMIT = 20_000
const COMMENT_OUTPUT_LIMIT = 15_000
const PLAN_TIMEOUT_MS = 60 * 60 * 1000
const EXEC_TIMEOUT_MS = 180 * 60 * 1000
const KILL_AFTER_MS = 5000
const CODEX_MODEL = process.env.LODESTAR_TASK_CODEX_MODEL ?? 'gpt-5.5'
const CODEX_REASONING_EFFORT = process.env.LODESTAR_TASK_CODEX_EFFORT ?? 'xhigh'

let timer: ReturnType<typeof setInterval> | null = null
let bootTimer: ReturnType<typeof setTimeout> | null = null
let running = false

export function startTasklistWorker(): void {
  if (timer || bootTimer) return
  bootTimer = setTimeout(() => {
    bootTimer = null
    void runTasklistWorkerOnce()
    timer = setInterval(() => { void runTasklistWorkerOnce() }, TASKLIST_WORKER_INTERVAL_MS)
  }, TASKLIST_WORKER_BOOT_DELAY_MS)
  log(`tasklist-worker: scheduled every ${TASKLIST_WORKER_INTERVAL_MS / 1000}s`)
}

export async function runTasklistWorkerOnce(): Promise<void> {
  if (running) {
    log('tasklist-worker: previous scan still running, skip')
    return
  }
  running = true
  try {
    for (const binding of tasklist.listTasklistBindings()) {
      await processTasklist(binding.projectName)
    }
  } catch (e) {
    log(`tasklist-worker: scan failed: ${messageOf(e)}`)
  } finally {
    running = false
  }
}

/** binding 是否已存齐 lodestar 自己的 5 个 section guid(design + aiTodo/aiDoing/aiReview/done)。
 *  缺任意一个就走 ensureTasklistSections 补全(旧数据迁移 / 刚 enable 还没落 section)。 */
function hasLodestarSections(binding: TasklistBinding): boolean {
  const s = binding.sections
  return Boolean(s && s.design && s.aiTodo && s.aiDoing && s.aiReview && s.done)
}

async function processTasklist(projectName: string): Promise<void> {
  const projectDir = join(feishu.PROJECTS_ROOT, projectName)
  try {
    if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`)
    // ensureTasklistSections 改成低频自愈:section guid 稳态不变,没必要每个 tick 都
    // listTasklistSections + getTasklistSection 校验。只在 30min 时间窗外、或 binding 还没
    // 存齐 lodestar 5 个 section guid(旧数据 / 新 enable)时才 ensure 一次。
    const cachedBinding = tasklist.getTasklistBinding(projectName)
    if (!cachedBinding) throw new Error(`tasklist is not enabled for ${projectName}`)
    let binding = cachedBinding
    const lastEnsureMs = cachedBinding.worker?.lastSectionEnsureAt
      ? Date.parse(cachedBinding.worker.lastSectionEnsureAt) : 0
    if (Date.now() - lastEnsureMs > SECTION_ENSURE_INTERVAL_MS || !hasLodestarSections(cachedBinding)) {
      binding = await tasklist.ensureTasklistSections(projectName)
      safeUpdate(projectName, b => {
        b.worker ??= {}
        b.worker.lastSectionEnsureAt = new Date().toISOString()
      })
      binding = tasklist.getTasklistBinding(projectName) ?? binding
    }
    await markStaleRunningProcesses(projectName, binding)
    binding = tasklist.getTasklistBinding(projectName) ?? binding
    const buckets = await scanTaskSections(binding)
    rememberScan(projectName, buckets)

    if (await processCompletedReviewTask(projectName, projectDir, binding, buckets.aiReview)) return
    if (await processDesignTask(projectName, projectDir, binding, buckets.design)) return
    if (await processReadyTask(projectName, projectDir, binding, buckets.aiTodo, buckets.aiDoing, buckets.aiReview)) return
    if (await processExecutingTask(projectName, projectDir, binding, buckets.aiDoing)) return
  } catch (e) {
    const msg = messageOf(e)
    log(`tasklist-worker: ${projectName} failed: ${msg}`)
    safeUpdate(projectName, binding => {
      binding.worker ??= {}
      binding.worker.lastScanAt = new Date().toISOString()
      binding.worker.lastScanError = msg
    })
  }
}

type TaskBuckets = Record<TasklistSectionKey, feishu.TaskSummary[]>

export async function scanTaskSections(binding: TasklistBinding): Promise<TaskBuckets> {
  const sections = binding.sections ?? {}
  // lodestar 的 4 个 section 各拉一次(todo/doing 取 open;review/done 取 all,下游语义)。
  // **每个 section 只拉一次** —— 旧版先 Promise.all(所有 custom section 拉 open) 再在 return
  // 里又把 aiTodo/aiDoing/aiReview/done 拉一遍,同一批 section 打了两遍 section.tasks,是 worker
  // 空转的主要放大器(2026-07-30 配额审查:稳态每 tick 10 次 → 6 次)。design bucket 的减法
  // 用 guid 集合,review/done 取 all 是 open 的超集,不影响从 allOpenTasks(只含 open)里减的结果。
  const aiTodo = sections.aiTodo ? await feishu.listSectionTasks(sections.aiTodo, false) : []
  const aiDoing = sections.aiDoing ? await feishu.listSectionTasks(sections.aiDoing, false) : []
  const aiReview = sections.aiReview ? await feishu.listSectionTasks(sections.aiReview) : []
  const done = sections.done ? await feishu.listSectionTasks(sections.done) : []
  // 远端可能还有用户手建的非 lodestar section —— 它们的 task 也不能算 design,只拉这些
  // 「额外」section 的 open(lodestar 4 个已拉过,这里 filter 掉不重复)。
  const lodestarGuids = new Set(
    [sections.aiTodo, sections.aiDoing, sections.aiReview, sections.done]
      .filter((g): g is string => !!g),
  )
  const extraSections = customSectionsForDesignSubtraction(await feishu.listTasklistSections(binding.guid))
    .filter(section => !lodestarGuids.has(section.guid))
  const extraOpen = await Promise.all(
    extraSections.map(section => feishu.listSectionTasks(section.guid, false)),
  )
  const allOpenTasks = await feishu.listTasklistTasks(binding.guid, false)
  return {
    design: tasksOutsideCustomSections(allOpenTasks, [aiTodo, aiDoing, aiReview, done, ...extraOpen]),
    aiTodo, aiDoing, aiReview, done,
  }
}

export function customSectionsForDesignSubtraction(
  sections: feishu.TasklistSection[],
): feishu.TasklistSection[] {
  const designSectionName = tasklist.sectionNameForKey('design')
  return sections
    .filter(section => !section.isDefault)
    .filter(section => section.name !== designSectionName)
}

export function tasksOutsideCustomSections(
  allTasks: feishu.TaskSummary[],
  customSectionTasks: feishu.TaskSummary[][],
): feishu.TaskSummary[] {
  const customTaskGuids = new Set(customSectionTasks.flat().map(task => task.guid))
  return allTasks.filter(task => !customTaskGuids.has(task.guid))
}

function rememberScan(projectName: string, buckets: TaskBuckets): void {
  safeUpdate(projectName, binding => {
    const now = new Date().toISOString()
    binding.worker ??= {}
    binding.worker.lastScanAt = now
    binding.worker.lastScanError = undefined
    for (const [sectionKey, tasks] of Object.entries(buckets) as [TasklistSectionKey, feishu.TaskSummary[]][]) {
      for (const task of tasks) {
        const state = tasklist.taskStateFor(binding, task.guid)
        state.summary = task.summary
        state.sectionKey = sectionKey
        state.completedAt = task.completedAt
        state.lastSeenAt = now
      }
    }
  })
}

async function markStaleRunningProcesses(projectName: string, binding: TasklistBinding): Promise<void> {
  const runningProcesses = Object.values(binding.processes ?? {})
    .filter(record => record.status === 'running')
  for (const record of runningProcesses) {
    if (isRecordedProcessAlive(record)) continue
    const error = `recorded ${record.kind} process is no longer running (pid ${record.pid ?? 'unknown'})`
    log(`tasklist-worker: mark stale process failed project=${projectName} run=${record.runId}: ${error}`)
    markProcessFailed(projectName, record, error)
    if (record.taskGuid) {
      try {
        await commentAndStoreError(projectName, record.taskGuid, `自动化进程已丢失：${error}`)
      } catch (e) {
        log(`tasklist-worker: stale process comment failed run=${record.runId}: ${messageOf(e)}`)
      }
    }
  }
}

function isRecordedProcessAlive(record: AutomationProcessRecord): boolean {
  if (!record.pid || record.pid <= 0) return false
  const cmdline = processCmdline(record.pid)
  if (!cmdline) return false
  const expected = record.command[0]
  if (!expected) return true
  const expectedBase = expected.split(/[\\/]/).pop() ?? expected
  const commandMatches = cmdline.includes(expected) || cmdline.includes(expectedBase)
  if (!commandMatches) return false
  return record.command
    .slice(1)
    .filter(arg => arg && arg !== '<prompt>')
    .every(arg => cmdline.includes(arg))
}

function processCmdline(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 }).trim()
  } catch {
    return null
  }
}

async function processDesignTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  tasks: feishu.TaskSummary[],
): Promise<boolean> {
  for (const task of tasks) {
    const full = await loadStructuredTask(binding, 'design', task.guid)
    const fingerprint = designFingerprint(full)
    const state = getTaskState(projectName, task.guid)
    if (state.codexPlan?.status === 'running' || state.agyPlan?.status === 'running') return true
    const codexSettled = state.codexPlan?.fingerprint === fingerprint && !!state.codexPlan.status
    const agySettled = state.agyPlan?.fingerprint === fingerprint && !!state.agyPlan.status
    if (codexSettled && agySettled) continue

    if (!codexSettled) {
      const run = await runCodexPlan(projectName, projectDir, binding, task.guid, full, fingerprint)
      if (run.status !== 'exited') return true
    }
    if (!agySettled) {
      await runAgyPlan(projectName, projectDir, binding, task.guid, full, fingerprint)
    }
    return true
  }
  return false
}

async function processReadyTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  todo: feishu.TaskSummary[],
  doing: feishu.TaskSummary[],
  review: feishu.TaskSummary[],
): Promise<boolean> {
  if (doing.length > 0 || review.length > 0 || todo.length === 0) return false
  const stateRunning = tasklist.listTasklistBindings()
    .find(b => b.projectName === projectName)
    ?.processes
  if (stateRunning && Object.values(stateRunning).some(p => p.status === 'running' && p.kind === 'codex-execute')) {
    return true
  }
  const selected = await runAgyPick(projectName, projectDir, binding, todo)
  if (!selected) return true
  const doingGuid = binding.sections?.aiDoing
  if (!doingGuid) throw new Error('missing [AI]执行中 section guid')
  await feishu.moveTaskToSection(selected, binding.guid, doingGuid)
  safeUpdate(projectName, b => {
    const state = tasklist.taskStateFor(b, selected)
    state.sectionKey = 'aiDoing'
    state.codexExecution = undefined
    state.agyReview = undefined
    state.codexMerge = undefined
    state.executionBranch = undefined
    state.executionTag = undefined
    state.reviewBranch = undefined
    state.reviewRef = undefined
    state.lastError = undefined
    b.worker ??= {}
    b.worker.runningTaskGuid = selected
  })
  return true
}

async function processExecutingTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  doing: feishu.TaskSummary[],
): Promise<boolean> {
  if (doing.length === 0) return false
  const task = doing[0]
  const state = getTaskState(projectName, task.guid)
  if (state.codexExecution?.status === 'running') return true
  if (state.codexExecution?.status === 'failed') return true
  if (state.codexExecution?.status === 'exited') {
    return hasLocalReviewRequest(state)
      ? await reviewExecutedTask(projectName, projectDir, binding, task.guid)
      : true
  }

  const run = await runCodexExecution(projectName, projectDir, binding, task.guid)
  if (run.status !== 'exited') return true

  return await reviewExecutedTask(projectName, projectDir, binding, task.guid)
}

async function reviewExecutedTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
): Promise<boolean> {
  const latest = getTaskState(projectName, taskGuid)
  if (!hasLocalReviewRequest(latest)) return true
  if (latest.agyReview?.status === 'running') return true
  if (latest.agyReview?.status === 'failed') return true
  if (latest.agyReview?.status !== 'exited') {
    const run = await runAgyReview(projectName, projectDir, binding, taskGuid, reviewRequestText(latest))
    if (run.status !== 'exited') return true
  }
  const reviewGuid = binding.sections?.aiReview
  if (!reviewGuid) throw new Error('missing [AI]待审核 section guid')
  await feishu.moveTaskToSection(taskGuid, binding.guid, reviewGuid)
  safeUpdate(projectName, b => {
    const state = tasklist.taskStateFor(b, taskGuid)
    state.sectionKey = 'aiReview'
    b.worker ??= {}
    b.worker.runningTaskGuid = undefined
  })
  return true
}

async function processCompletedReviewTask(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  reviewTasks: feishu.TaskSummary[],
): Promise<boolean> {
  for (const task of reviewTasks) {
    if (!isManualMergeSignal(task)) continue
    const state = getTaskState(projectName, task.guid)
    if (state.codexMerge?.status === 'running') return true
    if (state.codexMerge?.status === 'exited') continue
    if (state.codexMerge?.status === 'failed') return true
    if (!hasLocalReviewRequest(state)) {
      await commentAndStoreError(projectName, task.guid, '审核完成后无法合并：本地状态里没有本地审查请求。')
      return true
    }
    const reviewRequest = reviewRequestText(state)
    const run = await runCodexMerge(projectName, projectDir, binding, task.guid, reviewRequest)
    if (run.status !== 'exited') return true
    if (!String(run.stdoutTail ?? '').includes('LODESTAR_MERGE_STATUS: MERGED')) {
      await commentAndStoreError(projectName, task.guid, 'Codex 合并进程未明确输出 `LODESTAR_MERGE_STATUS: MERGED`，任务保留在审核分组。')
      return true
    }
    const merged = isReviewHeadMerged(projectDir, reviewRequest)
    if (!merged.ok) {
      await commentAndStoreError(projectName, task.guid, `Codex 合并进程输出 MERGED，但本地 Git 未确认合并：${merged.error}`)
      return true
    }
    const doneGuid = binding.sections?.done
    if (!doneGuid) throw new Error('missing 已完成 section guid')
    await feishu.moveTaskToSection(task.guid, binding.guid, doneGuid)
    safeUpdate(projectName, b => {
      const state = tasklist.taskStateFor(b, task.guid)
      state.sectionKey = 'done'
    })
    return true
  }
  return false
}

export function isManualMergeSignal(task: feishu.TaskSummary): boolean {
  return typeof task.completedAt === 'string' && task.completedAt.trim().length > 0
}

async function runCodexPlan(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  structured: unknown,
  fingerprint: string,
): Promise<TaskAutomationRunRef & { stdoutTail?: string }> {
  const prompt = [
    `你是 ${projectName} 项目的任务讨论者。`,
    '请结合项目实情，对这个需求做简单评审；不执行、不修改文件，可以帮着扩展想法。',
    '如果任务中有明确的询问性质内容，必须认真回答。',
    '最终回答以 gpt-5.5 的身份输出，内容会直接发到飞书任务评论区。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-plan',
    cwd: projectDir,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '-s', 'read-only',
      '-C', projectDir,
      prompt,
    ],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'codexPlan',
    fingerprint,
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('Codex 规划', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'codexPlan', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `Codex 规划失败：${processFailureText(result)}`)
  }
  return { runId: result.runId, status: result.status, fingerprint, stdoutTail: result.stdoutTail }
}

async function runAgyPlan(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  structured: unknown,
  fingerprint: string,
): Promise<TaskAutomationRunRef> {
  const prompt = [
    `你是 ${projectName} 项目的任务讨论者。`,
    '请结合项目实情，对这个需求做简单评审；不执行、不修改文件，可以帮着扩展想法。',
    '如果任务中有明确的询问性质内容，必须认真回答。',
    '最终回答以 gemini-3.1-pro 的身份输出，内容会直接发到飞书任务评论区。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'agy-plan',
    cwd: projectDir,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'agyPlan',
    fingerprint,
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('agy 看法', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'agyPlan', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `agy 规划失败：${processFailureText(result)}`)
  }
  return { runId: result.runId, status: result.status, fingerprint }
}

async function runAgyPick(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  tasks: feishu.TaskSummary[],
): Promise<string | null> {
  const prompt = [
    '你是 Lodestar 的任务调度 Agent。',
    '从候选任务里选择最适合下一个自动执行的一个任务。',
    '只输出 JSON：{"task_guid":"...","reason":"..."}，不要输出其他文字。',
    '',
    jsonBlock({ projectName, tasks }),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    kind: 'agy-pick',
    cwd: projectDir,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
  })
  if (result.status !== 'exited' || result.exitCode !== 0) {
    log(`tasklist-worker: agy pick failed for ${projectName}: ${processFailureText(result)}`)
    return null
  }
  const selected = parseSelectedTaskGuid(result.stdoutTail ?? '', tasks.map(t => t.guid))
  if (!selected) {
    safeUpdate(projectName, b => {
      b.worker ??= {}
      b.worker.lastScanError = 'agy pick did not return a valid task_guid'
    })
    return null
  }
  markRunOnTask(projectName, selected, 'agyPick', result.runId, undefined, 'exited')
  return selected
}

async function runCodexExecution(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
): Promise<AutomationProcessRecord> {
  const artifactTag = taskArtifactTag(taskGuid)
  assertTaskArtifactTagAvailable(projectDir, artifactTag)
  const worktreePath = prepareAutomationWorktree(projectDir, projectName, AI_AUTO_BRANCH)
  const structured = await loadStructuredTask(binding, 'aiDoing', taskGuid)
  const prompt = [
    '你是 Lodestar 自动执行 Agent。',
    '根据飞书任务完成代码实现，直接在当前仓库工作区修改文件。',
    '完成后运行与改动风险匹配的验证。不要提交 git commit，不要操作 GitHub 或远端 PR。',
    'worker 会在你完成后生成本地审查请求。',
    '最终回复必须包含变更摘要和验证结果。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-execute',
    cwd: worktreePath,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', worktreePath,
      prompt,
    ],
    timeoutMs: EXEC_TIMEOUT_MS,
    refKey: 'codexExecution',
  })
  if (result.status !== 'exited' || result.exitCode !== 0) {
    await commentAndStoreError(projectName, taskGuid, `Codex 执行失败：${processFailureText(result)}`)
    return result
  }

  try {
    const status = git(worktreePath, ['status', '--porcelain=v1']).trim()
    if (!status) {
      await commentAndStoreError(projectName, taskGuid, 'Codex 执行完成但没有产生仓库变更，未生成本地审查请求。')
      return markProcessFailed(projectName, result, 'Codex execution produced no repository changes')
    }
    const task = await feishu.getTask(taskGuid)
    const baseBranch = git(projectDir, ['branch', '--show-current']).trim()
    if (!baseBranch) throw new Error('cannot determine base branch from project directory')
    const baseHead = git(projectDir, ['rev-parse', 'HEAD']).trim()
    const commitMsg = commitTitle(task?.summary || taskGuid)
    git(worktreePath, ['add', '-A'])
    git(worktreePath, ['commit', '-m', commitMsg])
    const commitHash = git(worktreePath, ['rev-parse', 'HEAD']).trim()
    createTaskArtifactTag(worktreePath, artifactTag, commitHash)
    git(worktreePath, ['reset', '--hard', baseHead])
    const reviewRef = localReviewRef(baseHead, artifactTag)
    safeUpdate(projectName, b => {
      const state = tasklist.taskStateFor(b, taskGuid)
      state.executionBranch = AI_AUTO_BRANCH
      state.executionTag = artifactTag
      state.reviewBranch = AI_REVIEW_BRANCH
      state.reviewRef = reviewRef
    })
    try {
      await feishu.addTaskComment(taskGuid, agentComment('Codex 执行', [
        `任务产物：${artifactTag}`,
        `Base：${baseBranch}@${baseHead.slice(0, 12)}`,
        `Diff：${baseHead}..${artifactTag}`,
        `提交：${commitHash.slice(0, 12)}`,
        '',
        '输出摘要：',
        tail(result.stdoutTail ?? '', 6000),
      ].join('\n')))
    } catch (e) {
      const msg = `Codex 执行评论写入失败：${messageOf(e)}`
      log(`tasklist-worker: ${msg}`)
      safeUpdate(projectName, b => {
        const state = tasklist.taskStateFor(b, taskGuid)
        state.lastError = msg
      })
    }
  } catch (e) {
    const msg = messageOf(e)
    await commentAndStoreError(projectName, taskGuid, `Codex 执行后生成本地审查请求失败：${msg}`)
    return markProcessFailed(projectName, result, msg)
  }
  return result
}

async function runAgyReview(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  reviewRequest: string,
): Promise<AutomationProcessRecord> {
  const worktreePath = prepareAutomationWorktree(projectDir, projectName, AI_REVIEW_BRANCH)
  const structured = await loadStructuredTask(binding, 'aiReview', taskGuid)
  const diffSpec = reviewDiffSpec(reviewRequest)
  const headRef = reviewHeadRef(reviewRequest)
  const prompt = [
    '你是 Lodestar 自动审核 Agent。',
    `请审核本地审查请求：${reviewRequest}`,
    `当前工作区在 ${AI_REVIEW_BRANCH}，临时执行 worktree 分支是 ${AI_AUTO_BRANCH}。`,
    `任务产物 ref 是 ${headRef}。`,
    `重点查看 git diff ${diffSpec}，输出可以直接发到飞书任务评论区的审核意见。`,
    '不要修改文件，不要合并，不要操作 GitHub 或远端 PR。',
    '',
    '任务完整结构化数据：',
    jsonBlock(structured),
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'agy-review',
    cwd: worktreePath,
    command: [resolveAgyBin(), ...agyPrintArgs(prompt)],
    timeoutMs: PLAN_TIMEOUT_MS,
    refKey: 'agyReview',
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    const commentId = await feishu.addTaskComment(taskGuid, agentComment('agy 审核', result.stdoutTail ?? ''))
    markRunComment(projectName, taskGuid, 'agyReview', commentId)
  } else {
    await commentAndStoreError(projectName, taskGuid, `agy 审核失败：${processFailureText(result)}`)
  }
  return result
}

async function runCodexMerge(
  projectName: string,
  projectDir: string,
  binding: TasklistBinding,
  taskGuid: string,
  reviewRequest: string,
): Promise<AutomationProcessRecord> {
  const diffSpec = reviewDiffSpec(reviewRequest)
  const headRef = reviewHeadRef(reviewRequest)
  const prompt = [
    '你是 Lodestar 自动合并 Agent。',
    `任务已由人工在飞书清单中勾选完成。请合并本地审查请求：${reviewRequest}`,
    `任务产物 ref 是 ${headRef}。`,
    `只使用本地 Git，把 ${headRef} 合并到当前主工作区所在分支。`,
    `合并前确认工作区干净，并查看 git diff ${diffSpec}。`,
    '不要使用 GitHub、gh CLI、远端 PR 或 push。',
    '如发生冲突，按仓库约定解决并运行与风险匹配的验证。',
    '如果确认已经合并，最终输出一行：LODESTAR_MERGE_STATUS: MERGED',
    '如果不能合并，最终输出一行：LODESTAR_MERGE_STATUS: FAILED，并说明原因。',
  ].join('\n')
  const result = await runAgentProcess({
    projectName,
    tasklistGuid: binding.guid,
    taskGuid,
    kind: 'codex-merge',
    cwd: projectDir,
    command: [
      resolveCodexBin(),
      'exec',
      '-m', CODEX_MODEL,
      '-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', projectDir,
      prompt,
    ],
    timeoutMs: EXEC_TIMEOUT_MS,
    refKey: 'codexMerge',
  })
  const label = result.status === 'exited' && result.exitCode === 0 ? 'Codex 合并' : 'Codex 合并失败'
  await feishu.addTaskComment(taskGuid, agentComment(label, result.stdoutTail || processFailureText(result)))
  return result
}

type RunRefKey = 'codexPlan' | 'agyPlan' | 'agyPick' | 'codexExecution' | 'agyReview' | 'codexMerge'

async function runAgentProcess(opts: {
  projectName: string
  tasklistGuid: string
  taskGuid?: string
  kind: AutomationProcessRecord['kind']
  cwd: string
  command: string[]
  timeoutMs: number
  refKey?: RunRefKey
  fingerprint?: string
}): Promise<AutomationProcessRecord> {
  const runId = `${opts.kind}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  let record: AutomationProcessRecord = {
    runId,
    projectName: opts.projectName,
    tasklistGuid: opts.tasklistGuid,
    taskGuid: opts.taskGuid,
    kind: opts.kind,
    command: displayCommand(opts.command),
    cwd: opts.cwd,
    status: 'running',
    startedAt,
  }
  const proc = spawn(opts.command[0], opts.command.slice(1), {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(process.env as Record<string, string>), PATH: buildAgySpawnPath() },
    shell: process.platform === 'win32',
  })
  record = { ...record, pid: proc.pid || undefined }
  storeProcessRecord(opts.projectName, record)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, 'running')
  }
  log(`tasklist-worker: spawned ${opts.kind} run=${runId} pid=${record.pid ?? 'unknown'} cwd=${opts.cwd}`)

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', chunk => { stdout = tail(stdout + stdoutDecoder.write(chunk), PROCESS_OUTPUT_TAIL_LIMIT) })
  proc.stderr.on('data', chunk => { stderr = tail(stderr + stderrDecoder.write(chunk), PROCESS_OUTPUT_TAIL_LIMIT) })

  const finished = await waitForProcess(proc, opts.timeoutMs)
  stdout = tail(stdout + stdoutDecoder.end(), PROCESS_OUTPUT_TAIL_LIMIT)
  stderr = tail(stderr + stderrDecoder.end(), PROCESS_OUTPUT_TAIL_LIMIT)
  const status: AutomationProcessRecord['status'] = finished.error || finished.timedOut || finished.exitCode !== 0
    ? 'failed'
    : 'exited'
  const finalRecord: AutomationProcessRecord = {
    ...record,
    status,
    finishedAt: new Date().toISOString(),
    exitCode: finished.exitCode,
    signal: finished.signal,
    stdoutTail: stdout.trimEnd(),
    stderrTail: stderr.trimEnd(),
    error: finished.error ?? (finished.timedOut ? `${opts.kind} timed out after ${opts.timeoutMs / 1000}s` : undefined),
  }
  storeProcessRecord(opts.projectName, finalRecord)
  if (opts.taskGuid && opts.refKey) {
    markRunOnTask(opts.projectName, opts.taskGuid, opts.refKey, runId, opts.fingerprint, status, finalRecord.error)
  }
  return finalRecord
}

function waitForProcess(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; timedOut?: boolean; error?: string }> {
  return new Promise(resolve => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timeout = setTimeout(() => {
      if (settled) return
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) proc.kill('SIGKILL')
      }, KILL_AFTER_MS)
    }, timeoutMs)
    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode: null, signal: null, error: err.message })
    })
    proc.on('close', (code, signal) => {
      if (settled) return
      settled = true
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL'
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode: code, signal, timedOut })
    })
  })
}

async function loadStructuredTask(binding: TasklistBinding, sectionKey: TasklistSectionKey, taskGuid: string): Promise<unknown> {
  const task = await feishu.getTask(taskGuid)
  const comments = await feishu.listTaskComments(taskGuid)
  const ownCommentIds = ownRecordedCommentIds(getTaskState(binding.projectName, taskGuid))
  return {
    project: { name: binding.projectName, root: feishu.PROJECTS_ROOT },
    tasklist: {
      guid: binding.guid,
      name: binding.name,
      url: binding.url,
      section: tasklist.sectionNameForKey(sectionKey),
    },
    task,
    comments: comments.filter(comment => shouldIncludeTaskComment(comment, ownCommentIds)),
  }
}

export function shouldIncludeTaskComment(comment: feishu.TaskComment, ownCommentIds: Set<string>): boolean {
  if (ownCommentIds.has(comment.id)) return false
  const creator = comment.creator
  if (!creator || typeof creator !== 'object') return false
  return (creator as { type?: unknown }).type === 'user'
}

function designFingerprint(structured: any): string {
  const task = structured?.task ?? {}
  return createHash('sha256')
    .update(JSON.stringify({
      summary: task.summary,
      description: task.description,
      due: task.due,
      members: task.members,
      comments: structured?.comments ?? [],
    }))
    .digest('hex')
}

function hasLocalReviewRequest(state: TaskAutomationState): boolean {
  return Boolean(state.reviewRef || state.executionTag || state.executionBranch)
}

function reviewRequestText(state: TaskAutomationState): string {
  if (state.reviewRef) return state.reviewRef
  if (state.executionTag) return `local:HEAD..${state.executionTag}`
  if (state.executionBranch) return `local:HEAD..${state.executionBranch}`
  throw new Error('missing local review request')
}

function getTaskState(projectName: string, taskGuid: string): TaskAutomationState {
  const binding = tasklist.getTasklistBinding(projectName)
  if (!binding) throw new Error(`tasklist is not enabled for ${projectName}`)
  return binding.tasks?.[taskGuid] ?? { guid: taskGuid }
}

function safeUpdate(projectName: string, update: (binding: TasklistBinding) => void): void {
  try {
    tasklist.updateTasklistBinding(projectName, update)
  } catch (e) {
    log(`tasklist-worker: state update failed for ${projectName}: ${messageOf(e)}`)
  }
}

function storeProcessRecord(projectName: string, record: AutomationProcessRecord): void {
  safeUpdate(projectName, binding => {
    binding.processes ??= {}
    binding.processes[record.runId] = record
  })
}

function markProcessFailed(projectName: string, record: AutomationProcessRecord, error: string): AutomationProcessRecord {
  const failed: AutomationProcessRecord = {
    ...record,
    status: 'failed',
    error,
    finishedAt: record.finishedAt ?? new Date().toISOString(),
  }
  storeProcessRecord(projectName, failed)
  if (record.taskGuid) {
    const refKey = runRefKeyForProcess(record.kind)
    if (refKey) markRunOnTask(projectName, record.taskGuid, refKey, record.runId, undefined, 'failed', error)
  }
  return failed
}

function runRefKeyForProcess(kind: AutomationProcessRecord['kind']): RunRefKey | null {
  switch (kind) {
    case 'codex-plan': return 'codexPlan'
    case 'agy-plan': return 'agyPlan'
    case 'agy-pick': return 'agyPick'
    case 'codex-execute': return 'codexExecution'
    case 'agy-review': return 'agyReview'
    case 'codex-merge': return 'codexMerge'
  }
}

function markRunOnTask(
  projectName: string,
  taskGuid: string,
  key: RunRefKey,
  runId: string,
  fingerprint: string | undefined,
  status: AutomationProcessRecord['status'],
  error?: string,
): void {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state[key] = {
      ...(state[key] as TaskAutomationRunRef | undefined),
      runId,
      fingerprint,
      status,
      ...(status === 'running' ? { startedAt: new Date().toISOString() } : { finishedAt: new Date().toISOString() }),
      ...(error ? { error } : {}),
    }
  })
}

function markRunComment(projectName: string, taskGuid: string, key: RunRefKey, commentId: string): void {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    const ref = state[key] as TaskAutomationRunRef | undefined
    if (ref) ref.commentId = commentId
  })
}

async function commentAndStoreError(projectName: string, taskGuid: string, error: string): Promise<void> {
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state.lastError = error
  })
  const commentId = await feishu.addTaskComment(taskGuid, agentComment('Lodestar 自动化错误', error))
  safeUpdate(projectName, binding => {
    const state = tasklist.taskStateFor(binding, taskGuid)
    state.errorCommentIds = [...(state.errorCommentIds ?? []), commentId]
  })
}

function ownRecordedCommentIds(state: TaskAutomationState): Set<string> {
  const ids = [
    state.codexPlan?.commentId,
    state.agyPlan?.commentId,
    state.codexExecution?.commentId,
    state.agyReview?.commentId,
    state.codexMerge?.commentId,
    ...(state.errorCommentIds ?? []),
  ].filter((x): x is string => !!x)
  return new Set(ids)
}

function parseSelectedTaskGuid(output: string, allowed: string[]): string | null {
  try {
    const json = JSON.parse(output.trim())
    if (typeof json.task_guid === 'string' && allowed.includes(json.task_guid)) return json.task_guid
  } catch {}
  for (const guid of allowed) {
    if (output.includes(guid)) return guid
  }
  return null
}

function processFailureText(record: AutomationProcessRecord): string {
  return [
    record.error,
    `exit=${record.exitCode ?? 'null'} signal=${record.signal ?? 'null'} run=${record.runId} pid=${record.pid ?? 'unknown'}`,
    record.stderrTail ? `stderr:\n${tail(record.stderrTail, 4000)}` : '',
    record.stdoutTail ? `stdout:\n${tail(record.stdoutTail, 4000)}` : '',
  ].filter(Boolean).join('\n')
}

function displayCommand(command: string[]): string[] {
  if (command.length <= 1) return command
  return [...command.slice(0, -1), command[command.length - 1].length > 240 ? '<prompt>' : command[command.length - 1]]
}

function agentComment(title: string, content: string): string {
  return [
    `### ${title}`,
    '',
    trimForComment(content || '(empty)'),
  ].join('\n')
}

function trimForComment(content: string): string {
  const clean = sanitizeTaskCommentContent(content).trim()
  if (clean.length <= COMMENT_OUTPUT_LIMIT) return clean
  return `${clean.slice(0, COMMENT_OUTPUT_LIMIT)}\n\n[truncated ${clean.length - COMMENT_OUTPUT_LIMIT} chars]`
}

export function sanitizeTaskCommentContent(content: string): string {
  return content.replace(/\[([^\]\n]+)\]\(((?!https?:\/\/|applink:\/\/)[^)]+)\)/g, '$1')
}

function commitTitle(summary: string): string {
  const oneLine = summary.replace(/\s+/g, ' ').trim() || 'task'
  return `AI-AUTO: ${oneLine.slice(0, 80)}`
}

function jsonBlock(value: unknown): string {
  return fenced(JSON.stringify(value, null, 2), 'json')
}

function fenced(content: string, lang = ''): string {
  return '```' + lang + '\n' + content.replace(/```/g, '`\\`\\`') + '\n```'
}

function tail(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(s.length - limit)
}

function errorOutput(e: unknown): string {
  if (e && typeof e === 'object') {
    const any = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const stderr = any.stderr ? String(any.stderr).trim() : ''
    const stdout = any.stdout ? String(any.stdout).trim() : ''
    if (stderr) return stderr
    if (stdout) return stdout
    if (any.message) return any.message
  }
  return String(e)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
