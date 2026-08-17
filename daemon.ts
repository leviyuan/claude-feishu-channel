/**
 * Lodestar 2.0 daemon — Feishu (Lark) ↔ Codex app-server bridge.
 *
 * No source-file shebang on purpose:
 *   - `bun daemon.ts` and `systemctl --user start feishu-daemon` don't
 *     need it (they invoke the runtime explicitly).
 *   - `bun build --target=node --banner='#!/usr/bin/env node'` is the
 *     official entry; a duplicate shebang in source would survive into
 *     the bundle below the banner and break Node's parser (line-3
 *     shebang isn't recognized).
 *
 * Listens on Lark WebSocket for inbound messages and card-action
 * callbacks, routes each to a per-chat Session that owns a headless
 * `codex app-server` subprocess and a streaming Card Kit card.
 *
 * Run:   bun daemon.ts
 * Stop:  SIGTERM
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Session } from './src/session'
import * as feishu from './src/feishu'
import { actionCardResponse } from './src/card-action'
import {
  get as getNotifyCallback,
  markResolved as markNotifyCallbackResolved,
  dispatchCallback,
  isDispatching,
  setDispatching,
  clearDispatching,
  loadCallbacks,
  type NotifyButton,
  type NotifyRegistration,
} from './src/notify-callbacks'
import { buildNotifyCardFromReg } from './src/notify'
import { startNotifyServer } from './src/notify'
import { ensureFeishuNotifySkill } from './src/notify-skill'
import { startTasklistWorker } from './src/tasklist-worker'
import { config } from './src/config'
import { log } from './src/log'
import { DEBUG_CTX_FILE, DEBUG_SOCK_FILE, PID_FILE } from './src/paths'
import { checkPidGuard, writePidFile } from './src/pid-guard'

// ── PID guard ───────────────────────────────────────────────────────────
// dev 路径 (`bun daemon.ts` 直接跑) 不经过 cli.ts, 所以这里也守一道。
// 走 checkPidGuard 同一份逻辑: 校验 PID 文件里那个 pid 的 cmdline 包含
// 我们启动时记下的 marker, 避免 PID 被回收导致的假阳性把后续启动锁死。
{
  const guard = checkPidGuard(PID_FILE)
  if (guard.state === 'exit') {
    console.error(`lodestar-daemon: already running (pid ${guard.pid})`)
    process.exit(1)
  }
  if (existsSync(PID_FILE)) { try { unlinkSync(PID_FILE) } catch {} }
}

mkdirSync(dirname(PID_FILE), { recursive: true })
writePidFile(PID_FILE)

let cleanupDone = false
const cleanup = () => {
  if (cleanupDone) return
  cleanupDone = true
  // Snapshot which sessions are still alive so the next boot can
  // revive them — only the ones still running at shutdown, NOT
  // anything the user already `kill`-ed (those are absent from the
  // sessions Map filter below and stay stopped after restart).
  try {
    const alive = currentAliveSessionNames()
    feishu.writeAliveMarker(alive)
    if (alive.length > 0) log(`alive marker: [${alive.join(', ')}]`)
  } catch (e) { log(`alive marker write failed: ${e}`) }
  try { unlinkSync(PID_FILE) } catch {}
  try { unlinkSync(DEBUG_SOCK_FILE) } catch {}
}
process.on('exit', cleanup)
process.on('SIGTERM', () => { log('SIGTERM'); cleanup(); process.exit(0) })
process.on('SIGINT',  () => { log('SIGINT');  cleanup(); process.exit(0) })
// Windows 没有 POSIX SIGTERM;NSSM/WinSW 这类 Windows service wrapper
// 在停服务时通常发 SIGBREAK (Ctrl-Break 的内核映射),让进程优雅退出。
// 仅在 Win32 上注册,避免 Linux/Mac 跑 listener-count 检查时多出一个
// 无关的信号 handler。
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { log('SIGBREAK'); cleanup(); process.exit(0) })
}
process.on('unhandledRejection', e => log(`unhandledRejection: ${e}`))
process.on('uncaughtException',  e => log(`uncaughtException: ${e}`))

// ── Session registry ────────────────────────────────────────────────────
const sessions = new Map<string, Session>()  // key = chatId
let pendingReviveSessionNames = new Set<string>()

function currentAliveSessionNames(): string[] {
  const alive = new Set<string>()
  for (const s of sessions.values()) if (s.isRunning()) alive.add(s.sessionName)
  for (const name of pendingReviveSessionNames) alive.add(name)
  return [...alive]
}

function writeCurrentAliveMarker(): void {
  feishu.writeAliveMarker(currentAliveSessionNames())
}

function sessionFor(chatId: string, sessionName: string): Session {
  let s = sessions.get(chatId)
  if (!s) {
    s = new Session(sessionName, chatId, {
      onLifecycleChange: writeCurrentAliveMarker,
      onCreateTempSession: createTempSession,
      onDisbandTempSession: disbandTempSession,
    })
    sessions.set(chatId, s)
  }
  return s
}

/** 建临时群 + 在其中启动 session(btw 干净新会话 / fk 从 resumeSessionAt 锚点 fork)。
 *  SessionOpts 回调,由 session-temp 通过 s.opts 调用。*/
async function createTempSession(opts: {
  chatName: string
  userOpenId: string
  resumeSessionId?: string
  resumeSessionAt?: string
}): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  try {
    const ensured = await feishu.ensureChatForSession(opts.chatName, opts.userOpenId)
    const tempSession = sessionFor(ensured.chatId, opts.chatName)
    if (tempSession.isRunning()) {
      return { ok: false, error: `${opts.chatName} 已有会话在跑,先 bye 解散再重试` }
    }
    const ok = opts.resumeSessionId
      ? await tempSession.startForked(opts.resumeSessionId, opts.resumeSessionAt, { announce: true })
      : await tempSession.start({ announce: true })
    if (!ok) {
      // 启动失败:解散刚建的群 + 清 Session,不留半创建状态(群在但没 claude)。
      try { await feishu.disbandChatForSession(opts.chatName) } catch {}
      sessions.delete(ensured.chatId)
      tempSession.dispose()
      return { ok: false, error: `${tempSession.backendLabel()} 启动失败,已自动解散临时群` }
    }
    return { ok: true, chatId: ensured.chatId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`daemon: createTempSession "${opts.chatName}" failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/** 解散临时群 + 停掉它的 Session + 清锚点(bye 用)。*/
async function disbandTempSession(chatName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cid = feishu.chatIdForSession(chatName)
    if (cid) {
      const s = sessions.get(cid)
      if (s?.isRunning()) await s.stop('bye 解散', { announce: false })
      s?.dispose()
      sessions.delete(cid)
    }
    await feishu.disbandChatForSession(chatName)
    feishu.clearTurnAnchors(chatName)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`daemon: disbandTempSession "${chatName}" failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/** Auto-restart any session that was alive when the previous daemon
 * went down. Driven by the marker file written in `cleanup` — that
 * file ONLY lists sessions that were running, so anything the user
 * had explicitly `kill`-ed before shutdown is intentionally absent
 * and stays stopped. Each revived session is `restart(true)`-ed in
 * parallel so one slow Codex init does not block the rest; Codex resumes
 * the saved thread id and the in-flight conversation continues without
 * the user typing anything. */
async function reviveAliveSessions(): Promise<void> {
  const names = [...new Set(feishu.readAliveMarker())]
  if (names.length === 0) return
  pendingReviveSessionNames = new Set(names)
  log(`revive: ${names.length} session(s) marked alive on shutdown: ${names.join(', ')}`)
  try {
    await Promise.all(names.map(async sessionName => {
      const chatId = feishu.chatIdForSession(sessionName)
      if (!chatId) {
        log(`revive: no chatId binding for "${sessionName}", skip`)
        pendingReviveSessionNames.delete(sessionName)
        writeCurrentAliveMarker()
        return
      }
      const session = sessionFor(chatId, sessionName)
      try {
        const ok = await session.restart(true)
        if (ok) log(`revive: spawned "${sessionName}" (chat ${chatId.slice(0, 8)}…)`)
        else log(`revive: "${sessionName}" did not start`)
      } catch (e) {
        log(`revive: restart "${sessionName}" failed: ${e}`)
      } finally {
        pendingReviveSessionNames.delete(sessionName)
        writeCurrentAliveMarker()
      }
    }))
  } finally {
    pendingReviveSessionNames.clear()
    writeCurrentAliveMarker()
  }
}

// ── Feishu `post` (rich-text) → Markdown ────────────────────────────────
// 飞书客户端发 markdown 时,内容会被编码成 message_type='post' 的二维数组
// AST,不是 'text'。下面把它反向拼回 markdown 字符串(Codex 消化
// markdown 比拍平纯文本更结构化),并把内嵌图片/文件 key 抽出来交给
// `downloadAttachment` 走附件路径,跟原生 image/file 消息对齐。
//
// underline 暂不还原 —— markdown 无原生语法。
interface PostElement {
  tag: string
  text?: string
  href?: string
  style?: string[]
  image_key?: string
  file_key?: string
  file_name?: string
  user_id?: string
  user_name?: string
}
function extractPostMarkdown(
  contentObj: any,
): { markdown: string; imageKeys: string[]; fileKeys: { key: string; name?: string }[] } {
  const imageKeys: string[] = []
  const fileKeys: { key: string; name?: string }[] = []
  const paragraphs: string[] = []
  const title = typeof contentObj?.title === 'string' ? contentObj.title.trim() : ''
  if (title) paragraphs.push(`# ${title}`)
  const blocks: PostElement[][] = Array.isArray(contentObj?.content) ? contentObj.content : []
  for (const para of blocks) {
    if (!Array.isArray(para)) continue
    const parts: string[] = []
    for (const el of para) {
      if (!el || typeof el !== 'object') continue
      switch (el.tag) {
        case 'text': {
          let t = String(el.text ?? '')
          const styles = Array.isArray(el.style) ? el.style : []
          if (styles.includes('bold')) t = `**${t}**`
          if (styles.includes('italic')) t = `*${t}*`
          if (styles.includes('lineThrough') || styles.includes('strikethrough')) t = `~~${t}~~`
          parts.push(t)
          break
        }
        case 'a': {
          const href = String(el.href ?? '')
          const t = String(el.text ?? href)
          parts.push(`[${t}](${href})`)
          break
        }
        case 'at': {
          const name = String(el.user_name ?? el.user_id ?? '')
          parts.push(`@${name}`)
          break
        }
        case 'code_inline':
          parts.push(`\`${String(el.text ?? '')}\``)
          break
        case 'hr':
          parts.push('---')
          break
        case 'img':
          if (el.image_key) imageKeys.push(String(el.image_key))
          break
        case 'media':
          if (el.file_key) fileKeys.push({ key: String(el.file_key), name: el.file_name })
          break
        case 'emotion':
          // 飞书表情没有合适的 markdown 还原,塞 `:key:` 反而像代码引用
          break
        default:
          if (typeof el.text === 'string') parts.push(el.text)
      }
    }
    const line = parts.join('')
    if (line.trim()) paragraphs.push(line)
  }
  return { markdown: paragraphs.join('\n\n'), imageKeys, fileKeys }
}

// ── Inbound message handler ─────────────────────────────────────────────
const STALE_THRESHOLD_MS = 30_000
const seenMessageIds = new Set<string>()

async function handleMessage(data: any): Promise<void> {
  const message = data?.message
  if (!message) return

  // Feishu's im.message.receive_v1 event puts `sender` at the event
  // root, sibling of `message` — NOT inside `message` (we had this
  // wrong before, which silently emptied userOpenId and skipped every
  // urgent_app push). Try root first, fall back to nested in case the
  // SDK wraps the payload differently.
  const senderId = data?.sender?.sender_id ?? data?.event?.sender?.sender_id ?? message?.sender?.sender_id
  const userOpenId: string = senderId?.open_id ?? ''

  const msgId = message.message_id as string | undefined
  if (msgId && seenMessageIds.has(msgId)) return
  if (msgId) {
    seenMessageIds.add(msgId)
    if (seenMessageIds.size > 200) {
      const arr = [...seenMessageIds]
      seenMessageIds.clear()
      for (const id of arr.slice(-100)) seenMessageIds.add(id)
    }
  }

  // Drop replays of stale messages (Lark redelivers unacked events on reconnect).
  const createTime = Number(message.create_time ?? 0)
  if (createTime > 0 && Date.now() - createTime > STALE_THRESHOLD_MS) {
    log(`drop stale message ${msgId} age=${Math.round((Date.now() - createTime) / 1000)}s`)
    if (msgId) void feishu.addReaction(msgId, 'CrossMark')
    return
  }

  const chatId = message.chat_id as string

  // `[DEBUG]` prefix — seed the inject context with the real chat/sender
  // captured from a live WS event, then strip the prefix and continue as
  // normal. The injector script (scripts/test-inject.ts) reads this
  // context to replay arbitrary messages without the user touching Feishu.
  let contentObjForDebug: any = {}
  try { contentObjForDebug = JSON.parse(message.content ?? '{}') } catch {}
  const debugTextRaw = (message.message_type === 'text' ? contentObjForDebug.text ?? '' : '')
  if (typeof debugTextRaw === 'string' && debugTextRaw.startsWith('[DEBUG]')) {
    try {
      writeFileSync(DEBUG_CTX_FILE, JSON.stringify({
        chat_id: chatId,
        sender_open_id: userOpenId,
        seeded_at: new Date().toISOString(),
        seeded_msg_id: msgId ?? '',
      }, null, 2))
      log(`debug: seeded inject context chat=${chatId.slice(0, 8)}… sender=${userOpenId.slice(0, 8)}…`)
    } catch (e) { log(`debug: seed context failed: ${e}`) }
    const stripped = debugTextRaw.slice('[DEBUG]'.length)
    contentObjForDebug.text = stripped
    message.content = JSON.stringify(contentObjForDebug)
  }

  let groupName = feishu.chatNameCache.get(chatId)
  if (!groupName) {
    await feishu.refreshChatList()
    groupName = feishu.chatNameCache.get(chatId)
  }
  if (!groupName) {
    // refreshChatList 走的 im.chat.list 是最终一致的：机器人刚被拉进一个
    // 新群时，群往往要过几秒才出现在列表里，而用户的第一条消息恰恰落在
    // 这个窗口。按 chat_id 直接点查 im.chat.get —— 同一数据源的更精确查询，
    // 拿得到列表还没刷出来的新群名，新群第一条消息就能接住。
    groupName = (await feishu.fetchChatName(chatId)) ?? undefined
  }
  if (!groupName) {
    log(`unknown chat ${chatId}, dropping message`)
    await feishu.sendText(chatId, '❌ 无法识别群名。请确认：① 机器人已被拉进本群；② 群已设置名称（未命名群拿不到群名，无法映射项目目录）。设置后再发一条消息即可。')
    return
  }
  const sessionName = feishu.sanitizeSessionName(groupName)
  feishu.bindSessionToChat(sessionName, chatId)
  const session = sessionFor(chatId, sessionName)

  let contentObj: any = {}
  try { contentObj = JSON.parse(message.content ?? '{}') } catch {}
  const msgType = message.message_type as string
  let text = ''
  const filePaths: string[] = []
  if (msgType === 'text') {
    text = (contentObj.text ?? '').trim()
  } else if (msgType === 'post') {
    // 飞书客户端 markdown 走 'post' 富文本通道,不是 'text'。反向拼回
    // markdown 给 Codex,内嵌图片/文件 key 走跟原生 image/file 一样的
    // downloadAttachment 路径。
    const post = extractPostMarkdown(contentObj)
    text = post.markdown.trim()
    for (const key of post.imageKeys) {
      const p = await feishu.downloadAttachment(message.message_id, key, 'image')
      if (p) filePaths.push(p)
    }
    for (const f of post.fileKeys) {
      const p = await feishu.downloadAttachment(message.message_id, f.key, 'file', f.name)
      if (p) filePaths.push(p)
    }
  }

  // Text-only control commands — intercept before any work that would
  // forward to Codex (download / spawn / interrupt). Bare words are
  // reserved globally by user request; `wt [name]` is also intercepted
  // for project worktree/group orchestration. Post 富文本整段不可能正好
  // 等于这些 bare word,所以这里只对 text 触发。
  if (msgType === 'text' && text) {
    if (await session.runCommand(text, userOpenId)) return
  }

  // 补录应答态:点「➕ 补录模型」后的下一条文本作为模型名消费(裸词命令
  // 已在上面优先分流)。同 AskUserQuestion 的消息应答语义。
  if (msgType === 'text' && text && await session.consumeModelCustomMessage(text, userOpenId)) {
    return
  }

  // Pending AskUserQuestion: route the message as a custom answer
  // instead of opening a new turn. This is how custom-text answers
  // work in this version — Feishu schema 2.0 doesn't support form/
  // input elements, so the chat box itself is the input. Only applies
  // to text-only messages (post / 图片 / 文件附件都按一次新轮处理)。
  if (msgType === 'text' && text && session.hasPendingAsk()) {
    // ✅ 不在这里抢打 —— 只有 onAskMessageAnswer 真把这条文本记成 ask
    // 答案时才回 ✅。撞上僵尸 ask(can_use_tool 没来)时这条消息会被当
    // 普通新轮重处理,不该留"答案已收到"标记。msgId 透传下去:成功消费
    // 时用来打 ✅,兜底重处理时让消息走完整的普通 reaction 生命周期。
    await session.onAskMessageAnswer(text, userOpenId, msgId ?? '')
    return
  }

  if (msgType === 'image' && contentObj.image_key) {
    const p = await feishu.downloadAttachment(message.message_id, contentObj.image_key, 'image')
    if (p) filePaths.push(p)
  } else if (msgType === 'file' && contentObj.file_key) {
    const p = await feishu.downloadAttachment(message.message_id, contentObj.file_key, 'file', contentObj.file_name)
    if (p) filePaths.push(p)
    if (!text) text = `(file: ${contentObj.file_name})`
  }

  if (!text && filePaths.length === 0) {
    // Post 已经走 markdown 解码;还落到空,要么是不支持的 message_type
    // (sticker / share_chat / audio / ...),要么是 post 里只剩 emotion /
    // 未知 tag。留 log 防再有"静默 1.5h"那种 case 没法回溯。
    log(`drop empty message ${msgId} type=${msgType}`)
    return
  }
  // 多条消息缓冲:>>> 开始收集 / <<< 收尾合并。返回 true = 已缓冲或已合并,
  // 不再往下走 onUserMessage。裸词控制命令已在上面 runCommand 先于本拦截。
  if (await session.onMultiMessageInbound(text, filePaths, userOpenId, msgId ?? '')) return
  await session.onUserMessage(text || '(empty)', filePaths, userOpenId, msgId ?? '')
}

// ── Card action handler ────────────────────────────────────────────────
async function handleCardAction(data: any): Promise<any> {
  const action = data?.action
  const value = action?.value
  if (!value?.kind) return
  const chatId = data?.context?.open_chat_id ?? ''
  const userId = data?.operator?.open_id ?? ''

  // Interactive /notify cards must route even when no Session exists for
  // this chat — a notify push doesn't start a session, and the click's
  // job is to ping the local caller, not drive a turn. Short-circuit
  // before the session guard below.
  if (value.kind === 'notify_callback') {
    return await handleNotifyCallback(value, chatId, userId)
  }

  const session = sessions.get(chatId)
  if (!session) return { toast: { type: 'error', content: '会话不存在，请先发消息启动' } }

  switch (value.kind) {
    case 'permission':
      await session.onPermissionDecision(value.request_id, value.decision, userId)
      return { toast: { type: value.decision === 'deny' ? 'error' : 'success', content: '已处理' } }
    case 'menu':
      await session.onUserMessage(`(menu choice ${value.choice + 1})`)
      return { toast: { type: 'success', content: 'OK' } }
    case 'provider_select': {
      const result = await session.onProviderSelect(String(value.source_id ?? ''), String(value.panel_id ?? ''))
      return result.card
        ? actionCardResponse(result.card)
        : { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
    }
    case 'model_select': {
      const result = await session.onModelSelect(String(value.model ?? ''), String(value.panel_id ?? ''), userId, value)
      return result.card
        ? actionCardResponse(result.card)
        : { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
    }
    case 'model_custom_prompt': {
      // context.open_message_id = 补录卡所在消息;等待态记住它,回复后原位更新。
      const result = await session.onModelCustomPrompt(
        String(value.source_id ?? ''),
        String(value.panel_id ?? ''),
        String(data?.context?.open_message_id ?? ''),
      )
      return result.card
        ? actionCardResponse(result.card)
        : { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
    }
    case 'model_panel_cancel': {
      const result = await session.onModelPanelCancel()
      return actionCardResponse(result.card)
    }
    case 'model_effort_select': {
      const result = await session.onModelEffortSelect(
        String(value.model ?? ''),
        String(value.effort ?? ''),
        String(value.panel_id ?? ''),
        userId,
        String(value.provider ?? ''),
      )
      return result.card
        ? actionCardResponse(result.card)
        : { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
    }
    case 'ask': {
      // Custom-text branch: form submit packages the input under
      // `form_value`. Try a couple of plausible keys since the exact
      // shape can drift between Feishu schema versions; fall back to
      // empty (onAskCustomAnswer ignores blank).
      if (value.custom) {
        const fv = action?.form_value ?? action?.input ?? {}
        const customText: string = fv?.custom_answer ?? action?.input_value ?? ''
        await session.onAskCustomAnswer(value.tool_use_id, value.question_idx ?? 0, customText, userId)
        return { toast: { type: customText.trim() ? 'success' : 'error', content: customText.trim() ? '已回答' : '请输入答案' } }
      }
      await session.onAskAnswer(value.tool_use_id, value.question_idx ?? 0, value.option_idx, userId)
      return { toast: { type: 'success', content: '已回答' } }
    }
    case 'worktree_disband': {
      const result = await session.onWorktreeDisband(String(value.slug ?? ''))
      return actionCardResponse(result.card)
    }
    case 'temp_fork_select': {
      await session.onForkSelect(Number(value.anchorIdx ?? -1), userId)
      return { toast: { type: 'success', content: '分叉中…' } }
    }
    case 'temp_back_select': {
      await session.onBackSelect(Number(value.anchorIdx ?? -1))
      return { toast: { type: 'success', content: '回滚中…' } }
    }
    case 'temp_resume_select': {
      await session.onResumeSelect(String(value.sessionId ?? ''))
      return { toast: { type: 'success', content: '恢复中…' } }
    }
    case 'tasklist_enable': {
      const result = await session.onTasklistEnable()
      return actionCardResponse(result.card)
    }
    case 'tasklist_delete_prompt': {
      const result = session.onTasklistDeletePrompt(String(value.guid ?? ''))
      return actionCardResponse(result.card)
    }
    case 'tasklist_delete_confirm': {
      const result = await session.onTasklistDeleteConfirm(String(value.guid ?? ''))
      return actionCardResponse(result.card)
    }
    case 'token_source_enable': {
      const { onTokenSourceEnable } = await import('./src/token-source-setup')
      await onTokenSourceEnable(session, String(value.source_id ?? ''))
      return { toast: { type: 'info', content: '已处理' } }
    }
    case 'agy_forward_codex': {
      const result = session.beginAgyForwardToCodex(String(value.result_id ?? ''), userId)
      return { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
    }
  }
  return { toast: { type: 'info', content: 'unknown action' } }
}

// ── Interactive /notify button callback ───────────────────────────────
// A group member tapped a button on a /notify card. Two visual phases
// (push mode), both rendered via message.patch on the original card:
//
//   ACK: a toast ("⏳ 已选择:X · 推送中…") returned instantly. Deliberately
//     NOT an inline card ACK, and NOT the callback-token endpoint:
//       • Method 1 (inline card ACK) + a follow-up update silently fails
//         to re-render.
//       • The callback-token endpoint `/interactive/v1/card/update` is a
//         legacy path that returns code=0 for our schema-2.0 card but
//         draws it BLANK (verified live, 2026-07-05).
//     So both card states go through message.patch AFTER the toast ACK.
//     The AGENTS.md footgun ("don't message.patch around a click") is
//     specifically BEFORE-ACK — the patch races the ACK response. After
//     a toast ACK (no card in the response) there's nothing to race.
//
//   Phase 1: message.patch → "⏳ 已选择:X · 推送中…", fired immediately so
//     the push's ~2.5s in-flight window shows progress.
//   Phase 2: message.patch → "✅ 反馈已送达" / "⚠️ 回调失败:…" once the
//     loopback push resolves.
//
// Pull / display-only mode (no callback) freezes on the verdict in a
// single inline step (no push to wait for). Every failure is surfaced
// on the card or toast — no silent swallow.
async function handleNotifyCallback(value: any, _chatId: string, userId: string): Promise<any> {
  const notifyId = String(value?.notify_id ?? '')
  const buttonId = String(value?.button_id ?? '')
  if (!notifyId) return { toast: { type: 'error', content: '回调缺少 notify_id' } }

  const reg = getNotifyCallback(notifyId)
  if (!reg) {
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… not found (expired or pre-restart)`)
    return { toast: { type: 'error', content: '通知已过期或已移除' } }
  }
  // Idempotency: a finalized card refuses re-fire ("已处理过"); an
  // in-flight Phase-2 refuses concurrent double-click ("处理中"). Both
  // prevent two members / a double-click from firing the push twice.
  if (reg.resolvedAt) {
    return { toast: { type: 'info', content: '已处理过' } }
  }
  if (isDispatching(notifyId)) {
    return { toast: { type: 'info', content: '处理中…' } }
  }
  const button = reg.buttons.find((b) => b.id === buttonId)
  if (!button) {
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… unknown button_id="${buttonId}"`)
    return { toast: { type: 'error', content: '未知按钮' } }
  }

  // Pull / display-only mode: no push to wait for — freeze on the
  // verdict now (single phase).
  if (!reg.callbackUrl) {
    markNotifyCallbackResolved(reg.notifyId, button.id, userId)
    log(`notify-callback: notify_id=${notifyId.slice(0, 12)}… resolved button="${buttonId}" by=${userId.slice(0, 8)}… (no callback, pull/display)`)
    return actionCardResponse(
      buildNotifyCardFromReg(reg, { status: 'done', buttonId: button.id, text: button.text, operatorOpenId: userId }),
    )
  }

  // Push mode: ACK with a toast immediately, then async drive BOTH card
  // states via message.patch on the original card (Phase 1 processing →
  // push → Phase 2 final). The dispatching guard is set synchronously
  // here so a fast second click is blocked before the async work starts.
  setDispatching(reg.notifyId)
  void pushNotifyCallbackPhase2(reg, button, userId)
  return { toast: { type: 'info', content: `⏳ 已选择:${button.text} · 推送中…` } }
}

// Drive the two card states via message.patch, fire-and-forget from
// {@link handleNotifyCallback} so the ACK toasts fast. Phase 1
// (processing) must precede the push so the in-flight window shows
// progress; Phase 2 (delivered/failed) lands once the push resolves.
// On push failure resolvedAt is NOT set (the dispatching guard is
// cleared) so the user can tap again to retry.
async function pushNotifyCallbackPhase2(
  reg: NotifyRegistration,
  button: NotifyButton,
  userId: string,
): Promise<void> {
  // Phase 1: processing card via message.patch (after the toast ACK).
  const processingCard = buildNotifyCardFromReg(reg, {
    status: 'processing', buttonId: button.id, text: button.text, operatorOpenId: userId,
  })
  try {
    await feishu.updateCard(reg.messageId, processingCard)
  } catch (e) {
    log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… phase-1 (processing) updateCard failed: ${e instanceof Error ? e.message : e}`)
  }

  // Push + Phase 2 final card.
  const result = await dispatchCallback(reg, button, userId)
  const resolution = result.ok
    ? { status: 'delivered' as const, buttonId: button.id, text: button.text, operatorOpenId: userId, reply: result.reply }
    : { status: 'failed' as const, buttonId: button.id, text: button.text, operatorOpenId: userId, detail: result.detail }
  const finalCard = buildNotifyCardFromReg(reg, resolution)
  try {
    await feishu.updateCard(reg.messageId, finalCard)
  } catch (e) {
    log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… phase-2 (final) updateCard failed: ${e instanceof Error ? e.message : e}`)
  }
  if (result.ok) {
    markNotifyCallbackResolved(reg.notifyId, button.id, userId)
  }
  clearDispatching(reg.notifyId)
  log(`notify-callback: notify_id=${reg.notifyId.slice(0, 12)}… button="${button.id}" ${result.ok ? 'delivered' : `failed: ${result.detail}`} by=${userId.slice(0, 8)}…`)
}

// ── WebSocket boot ─────────────────────────────────────────────────────
function fmt(m: any[]): string {
  return m.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
}

// ── Debug message injection ─────────────────────────────────────────────
// Listens on a unix socket so scripts/test-inject.ts can replay messages
// through the same `handleMessage` path that real WS events take. Seeded
// by a one-time `[DEBUG]<anything>` from the real Feishu user; from then
// on the injector reuses that chat_id + sender_open_id.
function startDebugSocket(): void {
  if (process.platform === 'win32') {
    // Bun.serve({unix:...}) 在 Windows 上不支持,且 debug 注入是
    // dev-only 路径(scripts/test-inject.ts 用的),end user 不需要。
    // 想在 Windows 上 spike 这个,换成 loopback HTTP 即可。
    log('debug: inject socket skipped on Windows (dev-only feature)')
    return
  }
  if (typeof Bun === 'undefined') {
    // 走 npm 发布出去给 end user 时跑的是 node,Bun.serve 不在。
    // debug 注入纯 dev-only(scripts/test-inject.ts 才用),production
    // 直接跳过即可 —— 既不报错也不引入 node:http 的 socket-path 端口
    // 适配工作量。本机 `bun daemon.ts` 因为 Bun 是 defined 的,这条
    // 分支不进。
    log('debug: inject socket skipped (Bun runtime only — npm/Node build does not include it)')
    return
  }
  try { if (existsSync(DEBUG_SOCK_FILE)) unlinkSync(DEBUG_SOCK_FILE) } catch {}
  try {
    Bun.serve({
      unix: DEBUG_SOCK_FILE,
      fetch: async (req: Request) => {
        if (req.method !== 'POST') return new Response('use POST', { status: 405 })
        let body: any = {}
        try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
        if (!existsSync(DEBUG_CTX_FILE)) {
          return new Response('no debug context yet — send `[DEBUG]hi` from Feishu first', { status: 412 })
        }
        let ctx: any = {}
        try { ctx = JSON.parse(readFileSync(DEBUG_CTX_FILE, 'utf8')) } catch (e) {
          return new Response(`ctx read failed: ${e}`, { status: 500 })
        }
        const text: string = String(body.text ?? '')
        if (!text) return new Response('text required', { status: 400 })
        // 把 inject 内容**真发到目标群**,带"【自动化测试】"前缀让群成员
        // 一眼能区分。拿飞书返回的真 message_id 再构造 event 灌
        // handleMessage:
        //   - msg_id 是真的 → 后续 addReaction / 其它 outbound 不再因
        //     `om_DEBUG_*` 合成 id 报 99992354 污染飞书侧错误日志。
        //   - daemon 看到的 content.text 是**原始 text**(不含前缀),
        //     Codex 那头不会被"【自动化测试】"标签干扰。
        //   - bot 自己发的消息默认不通过 receive_v1 回环(飞书协议层防
        //     死循环),daemon 只通过这条 inject 路径看到一份消息,不会
        //     重复触发 handleMessage。
        const flaggedText = `【自动化测试】:${text}`
        const realMsgId = await feishu.sendText(ctx.chat_id, flaggedText)
        if (!realMsgId) {
          return new Response('sendText failed — see daemon log', { status: 502 })
        }
        const payload = {
          sender: { sender_id: { open_id: ctx.sender_open_id } },
          message: {
            message_id: realMsgId,
            chat_id: ctx.chat_id,
            message_type: 'text',
            content: JSON.stringify({ text }),
            create_time: String(Date.now()),
          },
        }
        log(`debug: inject text=${JSON.stringify(text).slice(0, 80)} msg_id=${realMsgId}`)
        // Don't await — match real WS dispatcher behavior (fire-and-forget per event).
        handleMessage(payload).catch(e => log(`debug: handleMessage rejected: ${e}`))
        return new Response(JSON.stringify({ ok: true, msg_id: realMsgId }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    try { chmodSync(DEBUG_SOCK_FILE, 0o600) } catch {}
    log(`debug: inject socket listening at ${DEBUG_SOCK_FILE}`)
  } catch (e) {
    log(`debug: socket bind failed: ${e}`)
  }
}

async function boot(): Promise<void> {
  log(`lodestar-daemon: pid ${process.pid} starting`)
  // token source registry 先于 session 构建填充:session 构造会查 registry 推导 tokenSourceId。
  // config.toml [token_source.*] 在此落地为可用的 TokenSource。
  const { buildTokenSourcesFromConfig } = await import('./src/token-source-builtins')
  buildTokenSourcesFromConfig()
  // 各 source 后台拉模型填 models(codex 拉 model/list,几秒;glm 内置同步)。
  // 不阻塞 boot —— 拉完前面板显 MISS,拉完自动有。失败如实留空,绝不假数据。
  const { refreshAllTokenSourceModels } = await import('./src/token-source')
  void refreshAllTokenSourceModels()
  feishu.loadSessionChatMap()
  feishu.loadSessionResumeMap()
  feishu.loadSessionTurnsMap()
  feishu.loadSessionModelMap()
  await feishu.refreshChatList()
  // 群名解析靠 chatNameCache,但新群/改名走 fetchChatName 点查,不依赖这里全量刷。
  // 5min 全量 chat.list 是纯空转(IM API 计入免费版配额),拉长到 30min 足够保持缓存新鲜。
  setInterval(() => { void feishu.refreshChatList() }, 30 * 60 * 1000)
  startTasklistWorker()

  // Lark WSClient sends pings every ~120s but doesn't verify pongs by default.
  // On a half-open TCP (NAT idle-kill, network blip) the socket stays OPEN and
  // 'close' never fires — we'd go silently deaf. SDK exposes `pingTimeout`:
  // after sending a ping, if no inbound frame arrives within the window the
  // socket is terminated, which triggers the 'close' handler and the SDK's
  // standard reconnect loop. The daemon process stays alive — every Codex
  // subprocess, card streaming state and setInterval is
  // preserved across the WS hiccup. We only let systemd restart us if the
  // SDK's own reconnect loop exhausts its retry budget (onError).
  let ws: lark.WSClient
  let lastEventAt = Date.now()        // 收到任意真实事件就刷新 = 通道存活铁证
  let consecRebuilds = 0
  let rebuilding = false
  let verifyTimer: ReturnType<typeof setTimeout> | null = null
  const SETTLE_MS = 1500              // 让 SDK 自身重连流程先落定再换 client
  const VERIFY_WINDOW_MS = 90_000     // rebuild 后等多久确认事件恢复
  const RECENT_ACTIVITY_MS = 10 * 60_000  // 重连前这段内有过事件 = 活跃群,值得重试
  const MAX_CONSEC_REBUILDS = 3       // 活跃群连续重建上限,到顶只告警不死循环

  let scheduledRebuildTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledRebuildDueAt = 0
  let scheduledRebuildReason = ''
  let scheduledRebuildVerifyAfter = false
  let rebuildWs: (reason: string, verifyAfter?: boolean) => void = (reason) => {
    log(`[ws] rebuild requested before WS init — ${reason}`)
  }
  const scheduleWsRebuild = (reason: string, delayMs = 0, verifyAfter = false) => {
    const dueAt = Date.now() + delayMs
    if (scheduledRebuildTimer) {
      scheduledRebuildVerifyAfter ||= verifyAfter
      if (dueAt >= scheduledRebuildDueAt) {
        log(`[ws] rebuild already scheduled — ${reason}`)
        return
      }
      clearTimeout(scheduledRebuildTimer)
    }
    scheduledRebuildDueAt = dueAt
    scheduledRebuildReason = reason
    scheduledRebuildVerifyAfter = verifyAfter
    scheduledRebuildTimer = setTimeout(() => {
      const scheduledReason = scheduledRebuildReason
      const scheduledVerifyAfter = scheduledRebuildVerifyAfter
      scheduledRebuildTimer = null
      scheduledRebuildDueAt = 0
      scheduledRebuildReason = ''
      scheduledRebuildVerifyAfter = false
      rebuildWs(scheduledReason, scheduledVerifyAfter)
    }, delayMs)
  }

  const wsLogger = {
    error: (m: any[]) => log(`[ws-sdk error] ${fmt(m)}`),
    warn:  (m: any[]) => {
      const text = fmt(m)
      log(`[ws-sdk warn] ${text}`)
      if (text.includes('no pong/inbound')) {
        scheduleWsRebuild(
          'ping-timeout: SDK liveness watchdog fired',
          2_000,
          (Date.now() - lastEventAt) < RECENT_ACTIVITY_MS,
        )
      }
    },
    info:  (m: any[]) => log(`[ws-sdk] ${fmt(m)}`),
    debug: (_m: any[]) => { /* drop */ },
    trace: (_m: any[]) => { /* drop */ },
  }
  const dispatcher = new lark.EventDispatcher({})

  // ── connected-but-deaf self-heal ────────────────────────────────────────
  // Feishu 长连接是**集群模式**(官方文档原话:"同一应用部署多个 client,
  // 只有随机一个 client 收到消息",且每 app ≤50 连接)。SDK 自带的重连
  // (reConnect → 同一个 WSClient 复用 tryConnect)断线后会重新握手成功、
  // pong 照常收发、getConnectionStatus().state==='connected' —— 但服务端
  // gateway 有时仍把旧连接当成该 app 的活跃 client,把事件**随机路由到那条
  // 已死的旧连接**,新连接 connected 却永远收不到任何 im.message 事件。
  // 这是 lark 长连接生态公认、但官方至今未修的 bug(同症状见 openclaw
  // #11719 / hermes-agent #24807)。三道旧防线全看不到它:pingTimeout 因
  // pong 仍在流动不触发;state 一直是 connected;onError 不报。
  //
  // 解法:不信 SDK 的同-client 重连,也不信 close()+start() in-place revive
  // (底层还是同一个 tryConnect,可能拉回同样被服务端判死的状态)。每次重连
  // 后**整个换一个全新的 lark.WSClient(新 token、新连接),force-close 旧的**
  // —— 这复刻了"整进程重启之所以管用"的核心(gateway 只剩一条新连可认),
  // 但全程不碰任何 Codex 子进程、不退进程。lastEventAt 作为唯一可信的"事件
  // 通道还活着"信号(不信 state);活跃群在 rebuild 后还聋就退避重建,封顶后
  // 只打日志、绝不 process.exit。
  const markEvent = () => {
    lastEventAt = Date.now()
    // 收到真实事件 = 通道确认健康:撤掉待验证、清零重建计数。
    consecRebuilds = 0
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null }
  }

  dispatcher.register({
    'im.message.receive_v1': async (d: any) => {
      markEvent()
      // ⚠️ 不要 await handleMessage —— Lark WS 长连接对事件 ack 有 ~4s
      // 硬超时,handleMessage 内部可能触发 openTurnCard / spawn Codex /
      // sendInterrupt 等数百 ms~数秒的链路,任一组合超 4s 飞书侧就判投递
      // 失败把事件直接丢弃(后台 event log 里这一类 errorInfo=timeout,
      // costMills≈3760ms,用户侧表现就是"发的消息 daemon 完全没收到")。
      // 这里立刻 return 让 dispatcher 回 ack,实际处理后台跑;handleMessage
      // 入口已用 seenMessageIds 做了同 message_id 去重,fire-and-forget
      // 不会引入重复处理。
      handleMessage(d).catch(e => log(`handleMessage: ${e}`))
    },
  })
  dispatcher.register({
    'card.action.trigger': async (d: any) => {
      markEvent()
      try { return await handleCardAction(d) } catch (e) { log(`handleCardAction: ${e}`) }
    },
  })

  const makeWs = (): lark.WSClient => new lark.WSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
    loggerLevel: lark.LoggerLevel.info,
    logger: wsLogger,
    // MUST be < the SDK's 120s pingInterval. The pong-watchdog is re-armed on
    // every ping and (deliberately) NOT re-armed on inbound; it only fires if a
    // full pingTimeout window elapses with no inbound between two pings. With
    // pingTimeout ≥ 120 the next ping always re-arms it before it can expire, so
    // on a half-open/zombie socket it NEVER terminates — the whole
    // close→reConnect→onReconnected→rebuildWs self-heal chain below stays dead.
    // 60s leaves margin under the 120s interval so a dead link is killed within
    // ~60s of the next ping. (Earlier 180 silently disabled the watchdog.)
    wsConfig: { pingTimeout: 60 },
    // Without this, connect() awaits the 'open'/'error' event forever when
    // neither fires (wedged WS upgrade behind NAT/proxy) — start() deadlocks
    // silently: process alive, REST fine, but permanently deaf, no log and no
    // reconnect (the pingTimeout watchdog only arms AFTER 'open'). 10s cap →
    // fail-fast into the SDK's reconnect loop instead of hanging indefinitely.
    handshakeTimeoutMs: 10_000,
    onReconnecting: () => log('[ws] reconnecting — WS lost, SDK is retrying'),
    // SDK 自己重连成功了 —— 但这正是僵尸聋的高发点。不信它,延迟一拍后整个
    // 换新 client(见 onReconnectedHeal)。
    onReconnected:  () => onReconnectedHeal(),
    // SDK exhausted its own reconnect budget. Do NOT exit the process — that
    // SIGTERMs every Codex subprocess / live card across all
    // groups. Rebuild a fresh WS client in place; the rest keeps running.
    onError: (err) => rebuildWs(`SDK onError: ${err?.message ?? err}`),
  })

  // Fresh-client rebuild: force-close the (possibly server-side-zombie) old
  // client, stand up a brand-new WSClient with a fresh token + connection, and
  // hand it the same dispatcher. Never touches Codex subprocesses or live
  // cards; never exits the process. close({force}) does
  // removeAllListeners() before terminate(), so the old client fires no stray
  // reconnect. verifyAfter arms a post-rebuild check (only for active groups).
  rebuildWs = (reason: string, verifyAfter = false) => {
    if (rebuilding) { log(`[ws] rebuild skipped (already rebuilding) — ${reason}`); return }
    if (scheduledRebuildTimer) {
      clearTimeout(scheduledRebuildTimer)
      scheduledRebuildTimer = null
      scheduledRebuildDueAt = 0
    }
    rebuilding = true
    consecRebuilds++
    log(`[ws] rebuild #${consecRebuilds} (fresh WSClient) — ${reason}`)
    const old = ws
    try { old?.close({ force: true }) } catch (e) { log(`[ws] rebuild: old close failed: ${e}`) }
    ws = makeWs()
    void ws.start({ eventDispatcher: dispatcher })
    rebuilding = false
    if (verifyAfter) armVerify()
  }

  // After a rebuild, confirm events actually resumed. lastEventAt is the only
  // trustworthy signal (state lies). If nothing arrives in the window, the
  // rebuild also landed deaf → rebuild again with the same window as backoff,
  // capped at MAX_CONSEC_REBUILDS. Past the cap we stop and log loudly (no
  // process exit, no alert spam) — the last client stays up and a manual
  // `systemctl --user restart feishu-daemon` is the escape hatch.
  const armVerify = () => {
    if (verifyTimer) clearTimeout(verifyTimer)
    const armedAt = Date.now()
    verifyTimer = setTimeout(() => {
      verifyTimer = null
      if (lastEventAt >= armedAt) { consecRebuilds = 0; return }  // events resumed → healthy
      if (consecRebuilds >= MAX_CONSEC_REBUILDS) {
        log(`[ws] STILL deaf after ${MAX_CONSEC_REBUILDS} fresh rebuilds — auto-heal exhausted, ` +
            `leaving last client up (no process exit). Escape hatch: systemctl --user restart feishu-daemon`)
        consecRebuilds = 0
        return
      }
      rebuildWs(`verify: no event ${Math.round((Date.now() - armedAt) / 1000)}s after rebuild`, true)
    }, VERIFY_WINDOW_MS)
  }

  // Every reconnect (any client) → replace it with a fresh one. Cheap (~3s WS
  // blip, no subprocess loss) and reconnects are rare (~4×/day), so doing it
  // unconditionally has near-zero cost and zero false-positive risk. Only arm
  // the verify-and-retry loop for groups that were active just before the drop
  // — a dormant group's post-reconnect silence is normal, not deafness, so it
  // gets the single precautionary rebuild and no retry storm.
  const onReconnectedHeal = () => {
    const wasRecentlyActive = (Date.now() - lastEventAt) < RECENT_ACTIVITY_MS
    log(`[ws] reconnected — swapping in a fresh WSClient (cluster-routing precaution; ` +
        `recentlyActive=${wasRecentlyActive})`)
    consecRebuilds = 0
    scheduleWsRebuild('post-reconnect precaution', SETTLE_MS, wasRecentlyActive)
  }

  ws = makeWs()
  void ws.start({ eventDispatcher: dispatcher })
  log(`lodestar-daemon: WS started, watching ${feishu.chatNameCache.size} groups`)

  // Liveness watchdog for the OTHER failure mode the deaf-heal can't see: a
  // wedged handshake / zombie socket that leaves the client stuck OFF
  // 'connected' with no callback firing. Poll state frequently; `idle` means
  // the SDK has no live socket and is not reconnecting, so rebuild immediately.
  // `connecting`/`reconnecting` gets a short grace window before we replace the
  // client. (connected-but-deaf is handled by the event-channel path above,
  // not here — state stays 'connected' in that case so this never sees it.)
  const WS_WATCHDOG_INTERVAL_MS = 15_000
  const WS_CONNECTING_GRACE_TICKS = 2
  let wsUnhealthyTicks = 0
  setInterval(() => {
    const { state } = ws.getConnectionStatus()
    if (state === 'connected') { wsUnhealthyTicks = 0; return }
    if (state === 'failed' || state === 'idle') {
      wsUnhealthyTicks = 0
      rebuildWs(`watchdog: state=${state}`)
      return
    }
    wsUnhealthyTicks++
    log(`[ws] watchdog: state=${state} (${wsUnhealthyTicks}/${WS_CONNECTING_GRACE_TICKS})`)
    if (wsUnhealthyTicks >= WS_CONNECTING_GRACE_TICKS) {
      wsUnhealthyTicks = 0
      rebuildWs(`watchdog: stuck in '${state}' ~${Math.round((WS_WATCHDOG_INTERVAL_MS * WS_CONNECTING_GRACE_TICKS) / 1000)}s`)
    }
  }, WS_WATCHDOG_INTERVAL_MS)

  startDebugSocket()
  // Reload persisted /notify button→callback registrations before the
  // notify server starts serving, so a card tapped right after a daemon
  // restart still routes to its caller. Prunes entries older than 7 days.
  loadCallbacks()
  startNotifyServer({ bind: config.notify.bind, port: config.notify.port })

  // Sync the feishu-notify skill into ~/.codex/skills (idempotent).
  // Lets the user's main Codex session push to bound groups via
  // /notify without manually placing the skill file. Runs after
  // notify server is up so the port number we bake into the skill
  // body matches what's actually listening.
  ensureFeishuNotifySkill()

  // Auto-revive sessions that were running when we last went down.
  // Runs AFTER the WS is up so any 🔁 revive message lands in the
  // right chat instead of disappearing into the void.
  await reviveAliveSessions()
}

boot().catch(e => { log(`boot fatal: ${e}`); process.exit(1) })
