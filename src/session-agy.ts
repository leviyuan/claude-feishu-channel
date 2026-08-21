import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import type { Session } from './session'
import * as cardkit from './cardkit'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import {
  AGY_DEFAULT_MODEL,
  AGY_HOST_TIMEOUT_MS,
  agyDisplayCommand,
  captureGitSnapshot,
  spawnAgyPrint,
  type AgyProcess,
  type GitSnapshot,
} from './agy-task'
import { messageOf, type ModelActionResult } from './session-util'

const AGY_CAPTURE_CHAR_LIMIT = 1_000_000
const AGY_FORCE_KILL_AFTER_MS = 5000
const AGY_RESULT_CARD_LIMIT = 8000
const AGY_STDERR_CARD_LIMIT = 2000
const AGY_STATUS_TICK_MS = 30_000

export interface AgyTaskState {
  proc: AgyProcess
  cardId: string
  messageId: string
  prompt: string
  startedAt: number
  beforeGit: GitSnapshot
  stdout: string
  stderr: string
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  decodersEnded: boolean
  stdoutBytes: number
  stderrBytes: number
  lastCpuPercent: number | null
  lastMemBytes: number | null
  captureTruncated: boolean
  cardWriteFailed: boolean
  finished: boolean
  stopRequested: boolean
  stopStatus?: string
  hostTimedOut: boolean
  spawnError?: string
  timer: ReturnType<typeof setInterval>
  hostTimeout: ReturnType<typeof setTimeout>
  forceKillTimer?: ReturnType<typeof setTimeout>
  done: Promise<void>
  resolveDone: () => void
}

export interface AgyForwardRecord {
  prompt: string
  used: boolean
}

function agyElapsedSec(task: AgyTaskState, now = Date.now()): string {
  return ((now - task.startedAt) / 1000).toFixed(1)
}

function agyProcessUsage(task: AgyTaskState): { cpuPercent: number | null; memBytes: number | null } {
  const pid = task.proc.pid
  if (!pid || process.platform === 'win32') {
    return { cpuPercent: task.lastCpuPercent, memBytes: task.lastMemBytes }
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', '%cpu=,rss='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const [cpuRaw, rssRaw] = out.split(/\s+/)
    const cpuPercent = Number.parseFloat(cpuRaw ?? '')
    const rssKb = Number.parseInt(rssRaw ?? '', 10)
    if (Number.isFinite(cpuPercent)) task.lastCpuPercent = cpuPercent
    if (Number.isFinite(rssKb)) task.lastMemBytes = rssKb * 1024
  } catch {
    // Process may already have exited between close and the final card update.
  }
  return { cpuPercent: task.lastCpuPercent, memBytes: task.lastMemBytes }
}

function agyFinalStderr(task: AgyTaskState): string {
  const parts = [task.stderr.trim()]
  if (task.spawnError) parts.push(`spawn error: ${task.spawnError}`)
  return parts.filter(Boolean).join('\n')
}

function agyStats(
  s: Session,
  task: AgyTaskState,
  status: string,
  endedAt?: number,
  exit?: { code: number | null; signal: string | null },
): cards.AgyStats {
  const stderr = agyFinalStderr(task)
  const usage = agyProcessUsage(task)
  return {
    status,
    model: AGY_DEFAULT_MODEL,
    cwd: s.workDir,
    command: agyDisplayCommand(),
    startedAtMs: task.startedAt,
    elapsedSec: agyElapsedSec(task, endedAt ?? Date.now()),
    cpuPercent: usage.cpuPercent,
    memBytes: usage.memBytes,
    ...(endedAt ? { endedAtMs: endedAt } : {}),
    ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}),
    stdoutBytes: task.stdoutBytes,
    stderrBytes: task.stderrBytes,
    captureTruncated: task.captureTruncated,
    cardTruncated: task.stdout.length > AGY_RESULT_CARD_LIMIT || stderr.length > AGY_STDERR_CARD_LIMIT,
    hostTimedOut: task.hostTimedOut,
  }
}

function updateAgyStats(s: Session, task: AgyTaskState, status: string): void {
  void cardkit.replaceElement(
    task.cardId,
    cards.ELEMENTS.agyStats,
    cards.agyStatsElement(agyStats(s, task, status)),
  )
}

function appendAgyText(task: AgyTaskState, stream: 'stdout' | 'stderr', text: string): void {
  if (!text) return
  const prev = stream === 'stdout' ? task.stdout : task.stderr
  const room = AGY_CAPTURE_CHAR_LIMIT - prev.length
  if (room <= 0) {
    task.captureTruncated = true
    return
  }
  const next = prev + text.slice(0, room)
  if (stream === 'stdout') task.stdout = next
  else task.stderr = next
  if (text.length > room) task.captureTruncated = true
}

function finishAgyDecoders(task: AgyTaskState): void {
  if (task.decodersEnded) return
  task.decodersEnded = true
  const stdoutTail = task.stdoutDecoder.end()
  const stderrTail = task.stderrDecoder.end()
  if (stdoutTail) appendAgyText(task, 'stdout', stdoutTail)
  if (stderrTail) appendAgyText(task, 'stderr', stderrTail)
}

function appendAgyOutput(task: AgyTaskState, stream: 'stdout' | 'stderr', chunk: Buffer): void {
  if (stream === 'stdout') task.stdoutBytes += chunk.length
  else task.stderrBytes += chunk.length
  const text = stream === 'stdout'
    ? task.stdoutDecoder.write(chunk)
    : task.stderrDecoder.write(chunk)
  appendAgyText(task, stream, text)
}

function agyForwardPrompt(task: AgyTaskState, stderr: string, notice: string): string {
  const stdout = cards.cleanAgyOutputText(task.stdout).trim()
  const cleanedStderr = cards.cleanAgyOutputText(stderr).trim()
  const cleanedNotice = cards.cleanAgyOutputText(notice).trim()
  const parts = [
    'agy 返回结果如下，请基于这份结果继续处理。',
    '',
    '原始 agy 任务:',
    task.prompt.trim(),
    '',
    'agy 结果:',
    stdout || '(无 stdout 输出)',
  ]
  if (cleanedNotice) parts.push('', 'agy 状态说明:', cleanedNotice)
  if (cleanedStderr) parts.push('', 'agy stderr:', cleanedStderr)
  if (task.captureTruncated) parts.push('', '注意: daemon 捕获的 agy 输出已截断。')
  return parts.join('\n')
}

function rememberAgyForwardPrompt(s: Session, task: AgyTaskState, stderr: string, notice: string): string {
  const id = randomUUID()
  s.agyForwardPrompts.set(id, { prompt: agyForwardPrompt(task, stderr, notice), used: false })
  if (s.agyForwardPrompts.size > 20) {
    const oldest = s.agyForwardPrompts.keys().next().value
    if (oldest) s.agyForwardPrompts.delete(oldest)
  }
  return id
}

export function beginAgyForwardToCodex(s: Session, resultIdRaw: string, userOpenId = ''): ModelActionResult {
  const backend = s.backendLabel()
  const resultId = resultIdRaw.trim()
  const record = s.agyForwardPrompts.get(resultId)
  if (!record) return { ok: false, message: 'agy 结果已过期，请重新运行 agy' }
  if (record.used) return { ok: false, message: 'agy 结果已转发，请勿重复点击' }
  if (s.startingAgy || s.runningAgy) return { ok: false, message: 'agy 任务仍在执行，请稍后再转发' }
  record.used = true
  void (async () => {
    try {
      await s.onUserMessage(record.prompt, [], userOpenId)
    } catch (e) {
      record.used = false
      const msg = `❌ agy 结果转发 ${backend} 失败: ${messageOf(e)}`
      log(`session "${s.sessionName}": ${msg}`)
      await feishu.sendTextRaw(s.chatId, msg)
    }
  })()
  return { ok: true, message: `已转发 ${backend}` }
}

export async function runAgyCommand(s: Session, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    await feishu.sendText(s.chatId, '用法: agy <任务说明>')
    return
  }
  if (s.startingAgy || s.runningAgy) {
    await feishu.sendText(s.chatId, '⏳ 当前已有 agy 任务在执行；请等待完成，或发送 stop 打断。')
    return
  }
  if (s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0) {
    await feishu.sendText(s.chatId, `⚠️ ${s.backendLabel()} 当前有正在执行或排队的 turn；请先发送 stop，或等待当前 turn 完成后再运行 agy。`)
    return
  }

  s.startingAgy = true
  const startedAt = Date.now()
  try {
    const beforeGit = await captureGitSnapshot(s.workDir)
    const initialStats: cards.AgyStats = {
      status: '⏳ agy 运行中',
      model: AGY_DEFAULT_MODEL,
      cwd: s.workDir,
      command: agyDisplayCommand(),
      startedAtMs: startedAt,
      elapsedSec: '0.0',
      stdoutBytes: 0,
      stderrBytes: 0,
    }
    const messageId = await feishu.sendCard(s.chatId, cards.agyTaskCard({
      sessionName: s.sessionName,
      prompt,
      stats: initialStats,
      beforeGit,
    }))
    if (!messageId) {
      await feishu.sendTextRaw(s.chatId, '❌ 创建 agy 卡片失败，任务未启动。')
      return
    }
    let cardId: string
    try {
      cardId = await cardkit.convertMessageToCard(messageId)
    } catch (e) {
      log(`session "${s.sessionName}": agy card id_convert failed: ${e}`)
      await feishu.sendTextRaw(s.chatId, `❌ agy 卡片初始化失败，任务未启动: ${messageOf(e)}`)
      return
    }

    let taskRef: AgyTaskState | null = null
    cardkit.recordCardCreated(cardId, 5, code => {
      if (taskRef?.cardWriteFailed) return
      if (taskRef) taskRef.cardWriteFailed = true
      const msg = `❌ agy 卡片更新失败${code ? ` code=${code}` : ''}，请查看 daemon 日志。`
      log(`session "${s.sessionName}": ${msg}`)
      void feishu.sendTextRaw(s.chatId, msg)
    })

    const { proc, bin, args } = spawnAgyPrint(prompt, s.workDir)
    log(`session "${s.sessionName}": spawn agy ${bin} ${args.slice(0, -1).join(' ')} <prompt> cwd=${s.workDir}`)
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    let task!: AgyTaskState
    task = {
      proc,
      cardId,
      messageId,
      prompt,
      startedAt,
      beforeGit,
      stdout: '',
      stderr: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      decodersEnded: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      lastCpuPercent: null,
      lastMemBytes: null,
      captureTruncated: false,
      cardWriteFailed: false,
      finished: false,
      stopRequested: false,
      hostTimedOut: false,
      timer: setInterval(() => updateAgyStats(s, task, task.stopRequested ? '🛑 正在停止 agy' : '⏳ agy 运行中'), AGY_STATUS_TICK_MS),
      hostTimeout: setTimeout(() => {
        if (task.finished) return
        task.hostTimedOut = true
        task.stopStatus = '❌ agy 超时'
        updateAgyStats(s, task, '❌ agy 超时，正在停止')
        terminateAgyProcess(task)
      }, AGY_HOST_TIMEOUT_MS),
      done,
      resolveDone,
    }
    taskRef = task
    s.runningAgy = task
    s.status = 'working'
    s.opts.onLifecycleChange?.()
    updateAgyStats(s, task, '⏳ agy 运行中')

    proc.stdout.on('data', chunk => appendAgyOutput(task, 'stdout', chunk))
    proc.stderr.on('data', chunk => appendAgyOutput(task, 'stderr', chunk))
    proc.on('error', err => {
      task.spawnError = err.message
      log(`session "${s.sessionName}": agy spawn error: ${err.message}`)
    })
    proc.on('close', (code, signal) => {
      void finishAgyTask(s, task, code, signal)
    })
  } finally {
    s.startingAgy = false
  }
}

function terminateAgyProcess(task: AgyTaskState): void {
  if (!task.proc.killed) task.proc.kill('SIGTERM')
  if (!task.forceKillTimer) {
    task.forceKillTimer = setTimeout(() => {
      if (!task.finished) task.proc.kill('SIGKILL')
    }, AGY_FORCE_KILL_AFTER_MS)
  }
}

export async function stopAgyTask(s: Session, status = '🛑 agy 已打断'): Promise<boolean> {
  const task = s.runningAgy
  if (!task) return false
  task.stopRequested = true
  task.stopStatus = status
  updateAgyStats(s, task, '🛑 正在停止 agy')
  terminateAgyProcess(task)
  await task.done
  return true
}

async function finishAgyTask(s: Session, task: AgyTaskState, code: number | null, signal: string | null): Promise<void> {
  if (task.finished) return
  task.finished = true
  finishAgyDecoders(task)
  clearInterval(task.timer)
  clearTimeout(task.hostTimeout)
  if (task.forceKillTimer) clearTimeout(task.forceKillTimer)

  let status = '❌ agy 失败'
  try {
    const endedAt = Date.now()
    const afterGit = await captureGitSnapshot(s.workDir)
    const stderr = agyFinalStderr(task)
    let notice = ''
    const cleanedStdout = cards.cleanAgyOutputText(task.stdout).trim()
    const cleanedStderr = cards.cleanAgyOutputText(stderr).trim()
    const emptyOutput = !cleanedStdout && !cleanedStderr
    if (code === 0 && !signal && !task.spawnError && !task.hostTimedOut && !task.stopRequested && emptyOutput) {
      notice = 'agy 进程退出码为 0，但没有返回 stdout/stderr。'
    }
    const ok = code === 0 && !signal && !task.spawnError && !task.hostTimedOut && !task.stopRequested && !emptyOutput
    status = task.stopRequested
      ? (task.stopStatus ?? '🛑 agy 已打断')
      : task.hostTimedOut
        ? '❌ agy 超时'
        : ok
          ? '✅ agy 完成'
          : '❌ agy 出错'
    const cardTruncated = task.stdout.length > AGY_RESULT_CARD_LIMIT || stderr.length > AGY_STDERR_CARD_LIMIT
    const forwardResultId = rememberAgyForwardPrompt(s, task, stderr, notice)

    await cardkit.flush(task.cardId)
    const statsLanded = await cardkit.replaceElementChecked(
      task.cardId,
      cards.ELEMENTS.agyStats,
      cards.agyStatsElement(agyStats(s, task, status, endedAt, { code, signal })),
    )
    const resultLanded = await cardkit.replaceElementChecked(
      task.cardId,
      cards.ELEMENTS.agyResult,
      cards.agyResultElement({
        status,
        stdout: task.stdout,
        stderr,
        notice,
        cardTruncated,
      }),
    )
    const forwardLanded = await cardkit.replaceElementChecked(
      task.cardId,
      cards.ELEMENTS.agyForward,
      cards.agyForwardElement(forwardResultId, s.backendLabel()),
    )
    const repoLanded = await cardkit.replaceElementChecked(
      task.cardId,
      cards.ELEMENTS.agyRepo,
      cards.agyRepoElement({ before: task.beforeGit, after: afterGit }),
    )
    cardkit.cancelSummary(task.cardId)
    const settingsLanded = await cardkit.patchSettingsChecked(task.cardId, cards.streamingOffSettings({
      durationSec: agyElapsedSec(task, endedAt),
      suffix: status,
    }))
    if (!statsLanded || !resultLanded || !forwardLanded || !repoLanded || !settingsLanded) {
      throw new Error([
        `stats=${statsLanded ? 'ok' : 'MISS'}`,
        `result=${resultLanded ? 'ok' : 'MISS'}`,
        `forward=${forwardLanded ? 'ok' : 'MISS'}`,
        `repo=${repoLanded ? 'ok' : 'MISS'}`,
        `settings=${settingsLanded ? 'ok' : 'MISS'}`,
      ].join(', '))
    }
    await cardkit.dispose(task.cardId)
  } catch (e) {
    status = `❌ agy 收尾失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": ${status}`)
    await feishu.sendTextRaw(s.chatId, status)
  } finally {
    if (s.runningAgy === task) {
      s.runningAgy = null
      s.status = s.isRunning() ? 'idle' : 'stopped'
      s.opts.onLifecycleChange?.()
    }
    log(`session "${s.sessionName}": agy finished status=${status} code=${code} signal=${signal} stdout=${task.stdoutBytes} stderr=${task.stderrBytes}`)
    task.resolveDone()
  }
}
