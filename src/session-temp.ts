/**
 * 临时会话 / fork / back / rs 恢复 —— 同目录多会话 + 语义化分叉/回滚。
 *
 * **rs 历史列表的数据源是 claude code 自己的 transcript 目录**
 * (~/.claude/projects/<encoded-cwd>/*.jsonl)——同 cwd 的所有会话天然在同目录,
 * worktree(不同 cwd)不会混进来;摘要从 transcript 首条用户输入提取。不维护自己的
 * 会话索引(之前用 resume-map + 后缀归属判断是错的:漏会话 + 把不同 cwd 的 worktree
 * 群误归项目)。
 *
 * fk/bk 的 turn 锚点仍用 daemon 记的 turn-map(每 turn 的 assistant uuid + Write 记录),
 * 它是 transcript 的预存索引,同源。
 */

import type { Session } from './session'
import * as feishu from './feishu'
import * as cards from './cards'
import { log } from './log'
import { claudeTranscriptDir } from './claude-agent-process'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

export interface TempSelectionResult {
  ok: boolean
  message: string
}

/** 当前群对应的项目名(剥 *ts 临时后缀 / [slug] worktree 后缀)。 */
function projectName(s: Session): string {
  return feishu.tempProjectName(s.sessionName) ?? s.worktreeProjectName() ?? s.sessionName
}

/** idx==0 = 会话起点(undefined,全新);idx>=1 = anchors[idx-1] 的 uuid。 */
function resumeAt(anchors: feishu.TurnAnchor[], idx: number): string | undefined {
  return idx >= 1 ? anchors[idx - 1]?.uuid : undefined
}

// ── rs 历史列表:扫 claude transcript 目录(同 cwd 全部会话) ───────────

/** 列同 cwd(workDir)的所有 claude 会话(transcript jsonl),按 mtime 倒序。
 *  24h 内优先,不足 minCount 补更早的到 minCount。摘要 = 首条用户输入。 */
function listClaudeSessions(workDir: string, withinMs: number, minCount: number): cards.ResumeListEntry[] {
  let dir: string
  try { dir = claudeTranscriptDir(workDir) } catch { return [] }
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const cutoff = Date.now() - withinMs
  const all: Array<cards.ResumeListEntry & { within: boolean }> = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(dir, name)
    let mtime: number
    try { mtime = statSync(full).mtimeMs } catch { continue }
    all.push({ sessionId: name.slice(0, -6), preview: firstUserSummary(full), ts: mtime, within: mtime >= cutoff })
  }
  all.sort((a, b) => b.ts - a.ts)
  const withinCount = all.filter(e => e.within).length
  const take = Math.max(minCount, withinCount)
  return all.slice(0, take).map(({ sessionId, preview, ts }) => ({ sessionId, preview, ts }))
}

/** 从 transcript 提取首条用户输入(会话主题)。优先 queue-operation 的 enqueue
 *  content(用户原始输入);fallback 首条 user message 的 text。只读前 64KB ——
 *  首条用户输入总在文件开头,避免对大 transcript 全量读(79 个会话扫一遍要快)。 */
function firstUserSummary(path: string): string {
  let text = ''
  try {
    const fd = openSync(path, 'r')
    const b = Buffer.alloc(65536)
    const n = readSync(fd, b, 0, 65536, 0)
    closeSync(fd)
    text = b.subarray(0, n).toString('utf8')
  } catch { return '' }
  let fallback = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string') {
      const c = d.content.trim()
      if (c) return c.slice(0, 80)
    }
    if (!fallback && d.type === 'user' && d.message) {
      const t = userMessageText(d.message)
      if (t) fallback = t
    }
  }
  return fallback.slice(0, 80)
}

function userMessageText(message: any): string {
  const c = message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

// ── 列表卡片 ──────────────────────────────────────────────────────────

export async function showForkList(s: Session): Promise<void> {
  const anchors = feishu.getTurnAnchors(s.sessionName)
  const entries = anchors.map((a, i) => ({ idx: i, preview: a.preview, ts: a.ts })).reverse()
  const card = cards.turnListCard({ projectName: projectName(s), mode: 'fork', entries })
  const messageId = await feishu.sendCard(s.chatId, card)
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ fk 列表发送失败')
}

export async function showBackList(s: Session): Promise<void> {
  const anchors = feishu.getTurnAnchors(s.sessionName)
  const entries = anchors.map((a, i) => ({ idx: i, preview: a.preview, ts: a.ts })).reverse()
  const card = cards.turnListCard({ projectName: projectName(s), mode: 'back', entries })
  const messageId = await feishu.sendCard(s.chatId, card)
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ bk 列表发送失败')
}

export async function showResumeList(s: Session): Promise<void> {
  const entries = listClaudeSessions(s.workDir, DAY_MS, 10)
  const card = cards.resumeListCard({ projectName: projectName(s), entries })
  const messageId = await feishu.sendCard(s.chatId, card)
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ rs 列表发送失败')
}

// ── btw / bye ─────────────────────────────────────────────────────────

export async function runBtwCommand(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId) { await feishu.sendText(s.chatId, '❌ 找不到发起人,无法建临时群。'); return }
  if (!s.opts.onCreateTempSession) { await feishu.sendText(s.chatId, '❌ 临时群能力未就绪(daemon 未注入回调)。'); return }
  if (s.selectedProvider !== 'claude') {
    await feishu.sendText(s.chatId, '❌ 临时会话/fork/back 暂只支持 Claude 后端(Codex 无 resumeSessionAt 能力)。群里发 model 切到 Claude 再试。')
    return
  }
  const chatName = feishu.tempChatName(projectName(s))
  await feishu.sendText(s.chatId, `🚀 开临时会话 ${chatName}(同目录,自动启动)…`)
  const r = await s.opts.onCreateTempSession({ chatName, userOpenId })
  if (!r.ok) await feishu.sendText(s.chatId, `❌ 建临时会话失败: ${r.error ?? '未知'}`)
}

export async function runByeCommand(s: Session): Promise<void> {
  if (!feishu.tempProjectName(s.sessionName)) {
    await feishu.sendText(s.chatId, '❌ bye 只能在临时会话群(*开头的群)里用。')
    return
  }
  if (!s.opts.onDisbandTempSession) { await feishu.sendText(s.chatId, '❌ 解散能力未就绪(daemon 未注入回调)。'); return }
  if (s.isRunning()) { await feishu.sendText(s.chatId, '⏳ 当前会话还在跑,先 stop/kill 再 bye。'); return }
  await feishu.sendText(s.chatId, `👋 解散临时会话 ${s.sessionName}…`)
  const r = await s.opts.onDisbandTempSession(s.sessionName)
  if (!r.ok) await feishu.sendText(s.chatId, `❌ 解散失败: ${r.error ?? '未知'}`)
}

// ── fork / back / resume 选择处理(卡片按钮回调) ──────────────────────

export async function onForkSelect(s: Session, anchorIdx: number, userOpenId: string): Promise<TempSelectionResult> {
  if (s.selectedProvider !== 'claude') return { ok: false, message: 'fork 暂只支持 Claude 后端，请先在 model 面板切换' }
  if (!userOpenId) return { ok: false, message: '找不到发起人，无法建临时群' }
  if (!s.opts.onCreateTempSession) return { ok: false, message: '临时群能力未就绪' }
  const anchors = feishu.getTurnAnchors(s.sessionName)
  if (anchorIdx < 0 || anchorIdx >= anchors.length) return { ok: false, message: '无效的分叉点，此选择卡可能已过期' }
  // idx==0 = 会话起点(全新,不 resume);idx>=1 = 回到 anchors[idx-1] 之前(用其 uuid)
  const isOrigin = anchorIdx === 0
  const resumeSessionId = isOrigin ? undefined : s.lastSessionId ?? undefined
  const resumeSessionAt = isOrigin ? undefined : resumeAt(anchors, anchorIdx)
  if (!isOrigin && !resumeSessionId) return { ok: false, message: '当前会话还没有 session id，无法分叉' }
  const chatName = feishu.tempChatName(projectName(s))
  log(`session-temp: fork ${s.sessionName}@${anchorIdx} → ${chatName} (at=${resumeSessionAt?.slice(0, 8) ?? 'origin'})`)
  try {
    await feishu.sendText(s.chatId, `🔱 分叉到 ${chatName}…`)
    const r = await s.opts.onCreateTempSession({ chatName, userOpenId, resumeSessionId, resumeSessionAt })
    if (!r?.ok) return { ok: false, message: `分叉失败: ${r?.error ?? '未知'}` }
  } catch (error) {
    return { ok: false, message: `分叉失败: ${error instanceof Error ? error.message : error}` }
  }
  // 不继承锚点:新临时群派生新 sid,旧 uuid 跨 sid 复用易错;新会话自己重新累积。
  return { ok: true, message: `已分叉到 ${chatName}` }
}

export async function onBackSelect(s: Session, anchorIdx: number): Promise<TempSelectionResult> {
  if (s.selectedProvider !== 'claude') return { ok: false, message: 'back 暂只支持 Claude 后端，请先在 model 面板切换' }
  const anchors = feishu.getTurnAnchors(s.sessionName)
  if (anchorIdx < 0 || anchorIdx >= anchors.length) return { ok: false, message: '无效的回滚点，此选择卡可能已过期' }
  const isOrigin = anchorIdx === 0
  const resumeSessionId = isOrigin ? undefined : s.lastSessionId ?? undefined
  const resumeSessionAt = isOrigin ? undefined : resumeAt(anchors, anchorIdx)
  // 先发 Write 记录卡(回滚段 = anchors[anchorIdx..end] 的 writes,被回滚掉的操作)
  const writes = anchors.slice(anchorIdx).flatMap(a => a.writes)
  try {
    await feishu.sendCard(s.chatId, cards.writeLogCard({ projectName: projectName(s), entries: writes })).catch(() => {})
    log(`session-temp: back ${s.sessionName}@${anchorIdx} (at=${resumeSessionAt?.slice(0, 8) ?? 'origin'}, writes=${writes.length})`)
    const ok = await s.rollbackTo(resumeSessionId, resumeSessionAt)
    if (!ok) return { ok: false, message: '回滚失败，锚点未改动，请检查日志后重试' }
    // 成功后再截断(reset 语义:回滚点之后作废)。失败则不动锚点 —— 用户可重试,不丢历史。
    feishu.truncateTurnAnchors(s.sessionName, anchorIdx)
    return { ok: true, message: isOrigin ? '已回滚到会话起点' : `已回滚到锚点 ${anchorIdx}` }
  } catch (error) {
    return { ok: false, message: `回滚失败: ${error instanceof Error ? error.message : error}` }
  }
}

export async function onResumeSelect(s: Session, sessionId: string): Promise<TempSelectionResult> {
  // sessionId 来自 transcript 文件名(同 cwd 的 claude 会话),直接 resume。
  if (s.selectedProvider !== 'claude') {
    return { ok: false, message: '历史会话恢复只支持 Claude 后端，请先在 model 面板切换' }
  }
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return { ok: false, message: '无效的历史会话，此选择卡可能已过期' }
  try {
    await feishu.sendText(s.chatId, `🔁 在本群恢复会话 ${normalizedSessionId.slice(0, 8)}…`)
    log(`session-temp: resume ${s.sessionName} ← claude session ${normalizedSessionId.slice(0, 8)}`)
    const ok = await s.rollbackTo(normalizedSessionId, undefined)
    if (!ok) return { ok: false, message: '恢复失败，请检查日志后重试' }
    feishu.clearTurnAnchors(s.sessionName)
    return { ok: true, message: `已恢复会话 ${normalizedSessionId.slice(0, 8)}…` }
  } catch (error) {
    return { ok: false, message: `恢复失败: ${error instanceof Error ? error.message : error}` }
  }
}
