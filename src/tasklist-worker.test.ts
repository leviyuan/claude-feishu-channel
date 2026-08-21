import { describe, expect, test, beforeEach } from 'bun:test'
import { spawn as spawnChild } from 'node:child_process'
import { once } from 'node:events'

import './feishu-test-mock'
import {
  resetFeishuMock,
  listSectionTasksCalls,
  listTasklistSectionsCalls,
  listTasklistTasksCalls,
} from './feishu-test-mock'
import {
  deleteTasklistRemoteIdempotently,
  isTasklistAlreadyDeletedError,
  markTasklistDeleting,
  mergeEnsuredTasklistSections,
  withTasklistLifecycleLock,
  type TasklistBinding,
} from './tasklist'
import type { TaskComment, TasklistSection, TaskSummary } from './feishu'
import {
  customSectionsForDesignSubtraction,
  isManualMergeSignal,
  localReviewRef,
  reviewDiffSpec,
  reviewHeadRef,
  roundRobinEntries,
  parseSelectedTaskGuid,
  sanitizeTaskCommentContent,
  shouldIncludeTaskComment,
  scanTaskSections,
  taskArtifactTag,
  automationTreeSupportWarning,
  hasRecoveredAutomationRunForProject,
  isAutomationRunTracked,
  registerRecoveredAutomationRun,
  startTasklistWorker,
  stopTasklistWorker,
  tasklistWorkerActivityIsIdle,
  terminateUnixProcessGroup,
  unixProcessGroupExists,
  tasksOutsideCustomSections,
} from './tasklist-worker'

function task(guid: string): TaskSummary {
  return { guid, summary: guid }
}

function section(guid: string, name: string, isDefault = false): TasklistSection {
  return { guid, name, isDefault }
}

describe('tasklist worker buckets', () => {
  test('treats tasks outside custom sections as design tasks', () => {
    expect(tasksOutsideCustomSections(
      [task('default-1'), task('todo-1'), task('default-2'), task('review-1')],
      [
        [task('todo-1')],
        [task('review-1')],
      ],
    )).toEqual([task('default-1'), task('default-2')])
  })

  test('does not subtract default or legacy design sections from design bucket', () => {
    expect(customSectionsForDesignSubtraction([
      section('default-design', '设计中', true),
      section('legacy-design', '设计中'),
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])).toEqual([
      section('todo', '[AI]待执行'),
      section('doing', '[AI]执行中'),
      section('done', '已完成'),
    ])
  })
})

describe('tasklist worker local reviews', () => {
  test('uses task checkbox completion as the merge signal', () => {
    expect(isManualMergeSignal(task('open'))).toBe(false)
    expect(isManualMergeSignal({ ...task('blank'), completedAt: '   ' })).toBe(false)
    expect(isManualMergeSignal({ ...task('done'), completedAt: '2026-06-13T10:30:00Z' })).toBe(true)
  })

  test('formats local review refs as base-to-head diffs', () => {
    expect(localReviewRef('abc123', 'AI-AUTO/task-guid')).toBe('local:abc123..AI-AUTO/task-guid')
  })

  test('formats task artifact tags under AI-AUTO namespace', () => {
    expect(taskArtifactTag('task-guid')).toBe('AI-AUTO/task-guid')
  })

  test('extracts diff spec and head ref from local review refs', () => {
    const ref = 'local:abc123..AI-AUTO/task-guid'
    expect(reviewDiffSpec(ref)).toBe('abc123..AI-AUTO/task-guid')
    expect(reviewHeadRef(ref)).toBe('AI-AUTO/task-guid')
  })
})

describe('tasklist worker task selection', () => {
  test('accepts exactly one allowed task_guid from strict JSON', () => {
    expect(parseSelectedTaskGuid('{"task_guid":"task-2","reason":"ready"}', ['task-1', 'task-2'])).toBe('task-2')
  })

  test('does not guess from prose, echoed candidates, or unknown ids', () => {
    expect(parseSelectedTaskGuid('I considered task-1 and task-2', ['task-1', 'task-2'])).toBeNull()
    expect(parseSelectedTaskGuid('{"task_guid":"task-3"}', ['task-1', 'task-2'])).toBeNull()
    expect(parseSelectedTaskGuid('```json\n{"task_guid":"task-1"}\n```', ['task-1'])).toBeNull()
  })
})

describe('tasklist worker project fairness', () => {
  test('rotates the fixed binding order between scans', () => {
    expect(roundRobinEntries(['a', 'b', 'c', 'd'], 2)).toEqual([
      { value: 'c', index: 2 },
      { value: 'd', index: 3 },
      { value: 'a', index: 0 },
      { value: 'b', index: 1 },
    ])
  })
})

describe('tasklist binding concurrency and deletion recovery', () => {
  test('merges ensured sections into the latest binding without erasing concurrent task/process state', () => {
    const latest: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
      sections: { design: 'old-design' },
      tasks: { task1: { guid: 'task1', summary: 'concurrent update' } },
      processes: {
        run1: {
          runId: 'run1', projectName: 'p', tasklistGuid: 'tl-1', kind: 'codex-plan',
          command: ['codex'], cwd: '/tmp', status: 'running', startedAt: '2026-08-21T00:00:00Z',
        },
      },
      worker: { lastScanAt: '2026-08-21T00:00:01Z' },
    }

    mergeEnsuredTasklistSections(latest, 'tl-1', { design: 'new-design', aiTodo: 'todo' })

    expect(latest.sections).toEqual({ design: 'new-design', aiTodo: 'todo' })
    expect(latest.tasks?.task1?.summary).toBe('concurrent update')
    expect(latest.processes?.run1?.status).toBe('running')
    expect(latest.worker?.lastScanAt).toBe('2026-08-21T00:00:01Z')
  })

  test('serializes same-project lifecycles while allowing different projects to overlap', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const events: string[] = []
    const first = withTasklistLifecycleLock('same', async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    await Promise.resolve()
    const second = withTasklistLifecycleLock('same', async () => { events.push('second') })
    const other = withTasklistLifecycleLock('other', async () => { events.push('other') })
    await other
    expect(events).toEqual(['first:start', 'other'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second'])
  })

  test('keeps one durable delete intent and accepts only Feishu code 1470404 as already deleted', async () => {
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
    }
    markTasklistDeleting(binding, '2026-08-21T00:00:00Z')
    markTasklistDeleting(binding, '2026-08-22T00:00:00Z')
    expect(binding.deleting).toEqual({ requestedAt: '2026-08-21T00:00:00Z', attempts: 0 })
    expect(isTasklistAlreadyDeletedError(new Error('feishu tasklist.delete failed code=1470404 msg=resource not found'))).toBe(true)
    expect(isTasklistAlreadyDeletedError({ code: 1470404 })).toBe(true)
    expect(isTasklistAlreadyDeletedError(new Error('feishu tasklist.delete failed code=1470405 msg=forbidden'))).toBe(false)
    expect(isTasklistAlreadyDeletedError(new Error('resource not found'))).toBe(false)
    await expect(deleteTasklistRemoteIdempotently('tl-1', async () => {
      throw new Error('feishu tasklist.delete failed code=1470404 msg=resource not found')
    })).resolves.toBe('already_deleted')
    await expect(deleteTasklistRemoteIdempotently('tl-1', async () => {
      throw new Error('feishu tasklist.delete failed code=1470405 msg=forbidden')
    })).rejects.toThrow('1470405')
  })
})

describe('tasklist worker process-tree supervision', () => {
  test('keeps the Windows limitation explicit without disabling task automation', () => {
    expect(automationTreeSupportWarning('win32')).toContain('Job Object')
    expect(automationTreeSupportWarning('linux')).toBeNull()
  })

  test('shutdown drain remains busy while deletion startup reconciliation is active', () => {
    expect(tasklistWorkerActivityIsIdle(0, 0, true)).toBe(false)
    expect(tasklistWorkerActivityIsIdle(0, 0, false)).toBe(true)
    expect(tasklistWorkerActivityIsIdle(1, 0, false)).toBe(false)
    expect(tasklistWorkerActivityIsIdle(0, 1, false)).toBe(false)
  })

  test('stopTasklistWorker waits for an in-flight startup deletion reconcile', async () => {
    let reconcileStarted!: () => void
    const started = new Promise<void>(resolve => { reconcileStarted = resolve })
    let releaseReconcile!: () => void
    const gate = new Promise<void>(resolve => { releaseReconcile = resolve })
    startTasklistWorker({
      bootDelayMs: 0,
      reconcileDeletions: async () => {
        reconcileStarted()
        await gate
      },
    })
    await started
    let stopped = false
    const stopping = stopTasklistWorker(500).then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stopped).toBe(false)
    releaseReconcile()
    await stopping
    expect(stopped).toBe(true)
  })

  test('terminates descendants that outlive a closed Unix leader', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })",
      'child.unref()',
    ].join(';')], { detached: true, stdio: 'ignore' })
    const pgid = leader.pid
    if (!pgid) throw new Error('test leader has no pid')
    try {
      await once(leader, 'close')
      expect(unixProcessGroupExists(pgid)).toBe(true)
      await terminateUnixProcessGroup(pgid, 2000)
      expect(unixProcessGroupExists(pgid)).toBe(false)
    } finally {
      try { process.kill(-pgid, 'SIGKILL') } catch {}
    }
  }, 10_000)

  test('adopts a validated persisted Unix run once and shutdown terminates its PGID', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = leader.pid
    if (!pid) throw new Error('test recovered leader has no pid')
    const closed = once(leader, 'close')
    const record = {
      runId: `recovered-${pid}`,
      projectName: 'p',
      tasklistGuid: 'tl-1',
      kind: 'codex-plan' as const,
      pid,
      pgid: pid,
      command: [process.execPath],
      cwd: '/tmp',
      status: 'running' as const,
      startedAt: '2026-08-21T00:00:00Z',
    }
    try {
      let adopted = false
      for (let attempt = 0; attempt < 20 && !adopted; attempt++) {
        adopted = registerRecoveredAutomationRun(record)
        if (!adopted) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(adopted).toBe(true)
      expect(registerRecoveredAutomationRun(record)).toBe(false)
      expect(isAutomationRunTracked(record.runId)).toBe(true)
      expect(hasRecoveredAutomationRunForProject('p')).toBe(true)
      await stopTasklistWorker(2000)
      await closed
      expect(isAutomationRunTracked(record.runId)).toBe(false)
      expect(hasRecoveredAutomationRunForProject('p')).toBe(false)
      expect(unixProcessGroupExists(pid)).toBe(false)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }, 10_000)

  test('long boot delay still adopts recovered PGID synchronously before immediate stop', async () => {
    if (process.platform === 'win32') return
    const leader = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = leader.pid
    if (!pid) throw new Error('test pre-boot recovered leader has no pid')
    const closed = once(leader, 'close')
    const record = {
      runId: `preboot-recovered-${pid}`,
      projectName: 'preboot-project',
      tasklistGuid: 'tl-preboot',
      kind: 'codex-plan' as const,
      pid,
      pgid: pid,
      command: [process.execPath],
      cwd: '/tmp',
      status: 'running' as const,
      startedAt: '2026-08-21T00:00:00Z',
    }
    try {
      let adopted = false
      startTasklistWorker({
        bootDelayMs: 60_000,
        adoptPersistedRuns: () => { adopted = registerRecoveredAutomationRun(record) },
        reconcileDeletions: async () => {},
      })
      expect(adopted).toBe(true)
      expect(isAutomationRunTracked(record.runId)).toBe(true)
      await stopTasklistWorker(2000)
      await closed
      expect(isAutomationRunTracked(record.runId)).toBe(false)
      expect(unixProcessGroupExists(pid)).toBe(false)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }, 10_000)
})

describe('tasklist worker comments', () => {
  test('removes local markdown link targets while preserving valid URLs', () => {
    expect(sanitizeTaskCommentContent(
      'Changed [worker](/home/leviyuan/feishu/src/tasklist-worker.ts) and [task](https://example.com/task/1).',
    )).toBe('Changed worker and [task](https://example.com/task/1).')
  })

  test('includes only user comments that are not already recorded automation output', () => {
    const ownCommentIds = new Set(['own'])
    expect(shouldIncludeTaskComment(comment('user', 'user'), ownCommentIds)).toBe(true)
    expect(shouldIncludeTaskComment(comment('app', 'app'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment(comment('own', 'user'), ownCommentIds)).toBe(false)
    expect(shouldIncludeTaskComment({ id: 'unknown', content: 'missing creator' }, ownCommentIds)).toBe(false)
  })
})

describe('tasklist worker scanTaskSections call budget', () => {
  beforeEach(() => resetFeishuMock())

  test('pulls each lodestar section exactly once (no double fetch)', async () => {
    // 稳态:5 个 section guid 齐全,远端无额外用户自建 section。
    // 旧版 listSectionTasks 会打 8 次(Promise.all 拉 4 个 custom + return 又拉 4 个固定,
    // 同一批 section 拉两遍) —— 这是 2026-07-30 配额审查的空转放大器。断言 4 次 = 每个
    // lodestar section 只拉一遍;tasklist.tasks 全量 1 次;section.list 1 次(发现自建 section)。
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
      sections: { design: 's-design', aiTodo: 's-todo', aiDoing: 's-doing', aiReview: 's-review', done: 's-done' },
    }
    await scanTaskSections(binding)
    expect(listSectionTasksCalls.length).toBe(4)
    expect(listTasklistTasksCalls.length).toBe(1)
    expect(listTasklistSectionsCalls.length).toBe(1)
  })

  test('skips sections it has no guid for', async () => {
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou', sections: {},
    }
    await scanTaskSections(binding)
    expect(listSectionTasksCalls.length).toBe(0)
    expect(listTasklistTasksCalls.length).toBe(1)
    expect(listTasklistSectionsCalls.length).toBe(1)
  })
})

function comment(id: string, creatorType: string): TaskComment {
  return { id, content: id, creator: { type: creatorType } }
}
