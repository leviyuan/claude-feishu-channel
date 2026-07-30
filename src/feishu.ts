/**
 * Feishu (Lark) primitives: Lark client, tenant token cache, chat
 * directory, sendText/sendCard, reactions, attachment download, project
 * provisioning, and Codex ChatGPT-auth check.
 *
 * Higher layers (cardkit / session / daemon) build on this.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { config, type ProjectProfile } from './config'
import { isCodexReasoningEffort, resolveCodexBin } from './codex-process'
import {
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import {
  ALIVE_MARKER_FILE,
  DATA_DIR,
  INBOX_DIR,
  SESSION_CHAT_MAP_FILE,
  SESSION_MODEL_MAP_FILE,
  SESSION_RESUME_MAP_FILE,
  SESSION_TURNS_MAP_FILE,
} from './paths'
import { log } from './log'

const APP_ID = config.feishu.app_id
const APP_SECRET = config.feishu.app_secret
export const PROJECTS_ROOT = config.runtime.projects_root

/** Per-project launch profile for `sessionName`, or undefined when the
 * project runs with Lodestar defaults. Sourced from `[projects.<name>].*`
 * in config.toml. Lets an external project (e.g. evolving) override cwd,
 * tool set, and MCP loading without touching other projects. */
export function projectProfile(sessionName: string): ProjectProfile | undefined {
  return config.projects[sessionName]
}

export const client = new lark.Client({
  appId: APP_ID, appSecret: APP_SECRET, disableTokenCache: false,
})

// ── Tenant token (cached, used by raw fetch wrappers) ──────────────────
let cachedToken = ''
let tokenExpiry = 0
export async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const data = await res.json() as { tenant_access_token?: string; expire?: number }
  if (!data.tenant_access_token) throw new Error('feishu: failed to obtain tenant token')
  cachedToken = data.tenant_access_token
  tokenExpiry = Date.now() + ((data.expire ?? 7200) - 60) * 1000
  return cachedToken
}

// ── Chat directory ─────────────────────────────────────────────────────
export const chatNameCache = new Map<string, string>()
export const preferredChatForSession = new Map<string, string>()

export function loadSessionChatMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_CHAT_MAP_FILE, 'utf8'))
    for (const [name, id] of Object.entries(obj)) {
      if (typeof id === 'string') preferredChatForSession.set(name, id)
    }
    log(`feishu: loaded ${preferredChatForSession.size} session→chat bindings`)
  } catch {}
}

function saveSessionChatMap(): void {
  try {
    const obj: Record<string, string> = {}
    for (const [k, v] of preferredChatForSession) obj[k] = v
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_CHAT_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-chat-map failed: ${e}`) }
}

export function bindSessionToChat(sessionName: string, chatId: string): void {
  if (preferredChatForSession.get(sessionName) === chatId) return
  const prev = preferredChatForSession.get(sessionName)
  preferredChatForSession.set(sessionName, chatId)
  saveSessionChatMap()
  log(`feishu: bound session "${sessionName}" → ${chatId}${prev ? ` (was ${prev})` : ''}`)
}

export function unbindSessionChat(sessionName: string): void {
  const prev = preferredChatForSession.get(sessionName)
  if (!prev) return
  preferredChatForSession.delete(sessionName)
  saveSessionChatMap()
  log(`feishu: unbound session "${sessionName}" from ${prev}`)
}

// ── Session resume map ────────────────────────────────────────────────
// `sessionName → provider → last-known thread/session id`. Persisted so
// daemon restarts don't strand the user with a fresh conversation when
// they next type `restart`. Updated when a turn starts, not when it
// finishes, so in-flight turns are resumable after daemon exit.
const lastSessionIdByName = new Map<string, Partial<Record<AgentProvider, string>>>()

function setSessionResumeInMemory(sessionName: string, provider: AgentProvider, sessionId: string): void {
  const entry = lastSessionIdByName.get(sessionName) ?? {}
  entry[provider] = sessionId
  lastSessionIdByName.set(sessionName, entry)
}

export function loadSessionResumeMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_RESUME_MAP_FILE, 'utf8'))
    for (const [name, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.trim()) {
        setSessionResumeInMemory(name, 'codex', value)
        continue
      }
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      const provider = record.provider === 'claude' || record.provider === 'codex'
        ? record.provider
        : null
      const sessionId = typeof record.sessionId === 'string'
        ? record.sessionId
        : typeof record.session_id === 'string'
          ? record.session_id
          : null
      if (provider && sessionId?.trim()) {
        setSessionResumeInMemory(name, provider, sessionId)
        continue
      }
      for (const p of ['codex', 'claude'] as const) {
        const id = record[p]
        if (typeof id === 'string' && id.trim()) setSessionResumeInMemory(name, p, id)
      }
    }
    log(`feishu: loaded ${lastSessionIdByName.size} session→resume bindings`)
  } catch {}
}

function saveSessionResumeMap(): void {
  try {
    const obj: Record<string, Partial<Record<AgentProvider, string>>> = {}
    for (const [k, v] of lastSessionIdByName) obj[k] = { ...v }
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_RESUME_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-resume-map failed: ${e}`) }
}

export function bindSessionResume(sessionName: string, sessionId: string, provider: AgentProvider = 'codex'): void {
  const prev = lastSessionIdByName.get(sessionName)?.[provider]
  if (prev === sessionId) return
  setSessionResumeInMemory(sessionName, provider, sessionId)
  saveSessionResumeMap()
}

export function getSessionResume(sessionName: string, provider: AgentProvider = 'codex'): string | null {
  return lastSessionIdByName.get(sessionName)?.[provider] ?? null
}

// ── Session turns map (fk/bk anchors + rs recent) ───────────────────
// `sessionName → TurnAnchor[]`。每 turn 结束记一条:本 turn 最后一条 assistant
// 消息的 uuid(SDK resumeSessionAt 锚点)+ 用户输入预览 + 时间。fk/bk 列"用户
// 输入前的分界点";rs 空闲模式列项目最近 24h 会话。fork/back 派生新会话时用
// seedTurnAnchors 给新群继承分叉点之前的历史锚点。
export interface TurnWrite {
  tool: string
  path: string
  body: string
}

export interface TurnAnchor {
  /** 本 turn 最后一条 assistant 消息 uuid — SDK resumeSessionAt 锚点 */
  uuid: string
  /** 该 uuid 所属的 Claude session_id。sid 漂移(provider切/clear/fork 后)校验用:
   *  旧 sid 的 uuid 不能配新 sid 的 transcript → 锚点失效,不展示/不可选。 */
  sid: string
  /** 本 turn 用户输入预览(首条文本,截断) */
  preview: string
  /** 时间戳 ms */
  ts: number
  /** 本 turn 的 Write 类工具记录(Write/Edit/NotebookEdit/MultiEdit),bk 回滚说明用 */
  writes: TurnWrite[]
}

const turnsBySession = new Map<string, TurnAnchor[]>()
const TURN_ANCHOR_MAX = 200

export function loadSessionTurnsMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_TURNS_MAP_FILE, 'utf8'))
    let n = 0
    for (const [name, arr] of Object.entries(obj)) {
      if (!Array.isArray(arr)) continue
      const clean = arr
        .filter((a: any) => a && typeof a.uuid === 'string' && typeof a.ts === 'number')
        .map((a: any) => ({
          uuid: String(a.uuid),
          sid: String(a.sid ?? ''),
          preview: String(a.preview ?? ''),
          ts: Number(a.ts),
          writes: Array.isArray(a.writes)
            ? a.writes
              .filter((w: any) => w && typeof w.path === 'string')
              .map((w: any) => ({ tool: String(w.tool ?? 'Write'), path: String(w.path), body: String(w.body ?? '') }))
              .filter((w: TurnWrite) => w.path !== '' || w.body !== '')
            : [],
        }))
      if (clean.length) { turnsBySession.set(name, clean); n += clean.length }
    }
    log(`feishu: loaded ${n} turn anchors across ${turnsBySession.size} sessions`)
  } catch (e: any) {
    // ENOENT(首次启动无文件)静默;其他(JSON 损坏等)要暴露,符合 no-fallbacks。
    if (e?.code !== 'ENOENT') log(`feishu: load session-turns-map failed: ${e?.message ?? e}`)
  }
}

function saveSessionTurnsMap(): void {
  try {
    const obj: Record<string, TurnAnchor[]> = {}
    for (const [k, v] of turnsBySession) obj[k] = v
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_TURNS_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-turns-map failed: ${e}`) }
}

export function appendTurnAnchor(sessionName: string, anchor: TurnAnchor): void {
  const arr = turnsBySession.get(sessionName) ?? []
  arr.push(anchor)
  if (arr.length > TURN_ANCHOR_MAX) arr.splice(0, arr.length - TURN_ANCHOR_MAX)
  turnsBySession.set(sessionName, arr)
  saveSessionTurnsMap()
}

export function getTurnAnchors(sessionName: string): TurnAnchor[] {
  return turnsBySession.get(sessionName) ?? []
}

/** back 回滚后:截断该 session 锚点到 keepCount 条(回滚点之后作废,reset 语义)。 */
export function truncateTurnAnchors(sessionName: string, keepCount: number): void {
  const arr = turnsBySession.get(sessionName)
  if (!arr || arr.length <= keepCount) return
  turnsBySession.set(sessionName, arr.slice(0, keepCount))
  saveSessionTurnsMap()
}

/** fork/back 派生新会话时,把分叉点之前的锚点继承给新群(不含分叉点本身)。 */
export function seedTurnAnchors(sessionName: string, from: TurnAnchor[]): void {
  if (from.length === 0) return
  turnsBySession.set(sessionName, from.slice())
  saveSessionTurnsMap()
}

export function clearTurnAnchors(sessionName: string): void {
  if (!turnsBySession.has(sessionName)) return
  turnsBySession.delete(sessionName)
  saveSessionTurnsMap()
}

// ── 临时群名(*MMDD-HHMM 后缀,同目录多会话) ─────────────────────────
// 与 worktree 的 [slug](独立目录 + git 分支)区分:*后缀 = 同一项目目录、新群、
// 新会话。workDir 解析靠 tempProjectName 剥后缀回原目录。
const TEMP_SUFFIX_RE = /\*[0-9]{4}-[0-9]{4}(-[0-9]+)?$/

/** 剥临时群 *MMDD-HHMM 后缀,返回原项目名;非临时群返回 null。 */
export function tempProjectName(sessionName: string): string | null {
  return TEMP_SUFFIX_RE.test(sessionName) ? sessionName.replace(TEMP_SUFFIX_RE, '') : null
}

/** 拼临时群名:projectName*MMDD-HHMM。同分钟已有同名则加 -2、-3… 去重。 */
export function tempChatName(projectName: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const used = new Set<string>([...chatNameCache.values(), ...turnsBySession.keys()])
  let name = `${projectName}*${stamp}`
  for (let seq = 2; used.has(name); seq++) name = `${projectName}*${stamp}-${seq}`
  return name
}

// ── Session model map ────────────────────────────────────────────────
// `sessionName → selected provider+model+effort`. This is a Lodestar
// preference, not a global CLI config edit: each Feishu group can choose
// independently and the selection is reapplied on thread start/resume.
// Loader accepts the older string value shape for compatibility; saver
// writes the provider-aware structured shape.
export interface SessionModelSelection {
  provider: AgentProvider
  /** token source 路径保存用户选中的真实 model slug；旧 Codex 记录可为 null。 */
  model: string | null
  effort: AgentReasoningEffort | null
  /** token source id(账号);新字段,旧数据无(构造时从 provider/model 推导)。 */
  tokenSourceId?: string | null
}

const selectedModelByName = new Map<string, SessionModelSelection>()

export function loadSessionModelMap(): void {
  try {
    const obj = JSON.parse(readFileSync(SESSION_MODEL_MAP_FILE, 'utf8'))
    for (const [name, selection] of Object.entries(obj)) {
      if (typeof selection === 'string' && selection.trim()) {
        selectedModelByName.set(name, {
          provider: providerFromModel(selection),
          model: selection,
          effort: null,
        })
        continue
      }
      if (!selection || typeof selection !== 'object') continue
      const model = (selection as { model?: unknown }).model
      const providerRaw = (selection as { provider?: unknown }).provider
      const provider: AgentProvider = providerRaw === 'claude' || providerRaw === 'codex'
        ? providerRaw
        : (typeof model === 'string' && model.trim() ? providerFromModel(model) : 'claude')
      const modelStr = typeof model === 'string' && model.trim() ? model : null
      // 兼容旧 Codex 空 model；Claude 必须有具体 model，否则丢弃。
      if (provider === 'claude' && !modelStr) continue
      const effort = (selection as { effort?: unknown }).effort
      const tokenSourceIdRaw = (selection as { tokenSourceId?: unknown }).tokenSourceId
      const tokenSourceId = typeof tokenSourceIdRaw === 'string' && tokenSourceIdRaw.trim()
        ? tokenSourceIdRaw.trim()
        : null
      const normalizedEffort = provider === 'claude'
        ? isClaudeReasoningEffort(effort) ? effort : null
        : isCodexReasoningEffort(effort) ? effort : null
      selectedModelByName.set(name, {
        provider,
        model: modelStr,
        effort: normalizedEffort,
        ...(tokenSourceId ? { tokenSourceId } : {}),
      })
    }
    log(`feishu: loaded ${selectedModelByName.size} session→model bindings`)
  } catch {}
}

function saveSessionModelMap(): void {
  try {
    const obj: Record<string, SessionModelSelection> = {}
    for (const [k, v] of selectedModelByName) obj[k] = v
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SESSION_MODEL_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) { log(`feishu: save session-model-map failed: ${e}`) }
}

export function bindSessionModel(
  sessionName: string,
  provider: AgentProvider,
  model: string | null,
  effort: AgentReasoningEffort | null,
  tokenSourceId?: string | null,
): void {
  const prev = selectedModelByName.get(sessionName)
  if (prev?.provider === provider && prev.model === model && prev.effort === effort && (prev.tokenSourceId ?? null) === (tokenSourceId ?? null)) return
  selectedModelByName.set(sessionName, { provider, model, effort, ...(tokenSourceId ? { tokenSourceId } : {}) })
  saveSessionModelMap()
}

export function getSessionModelSelection(sessionName: string): SessionModelSelection | null {
  // 临时群(*MMDD-HHMM 后缀)不入 map:先查自己(用户在临时群里显式选过则优先),
  // 没有就转发查主群名(tempProjectName 反解),让临时群首启继承主群档位而非走默认。
  // 读取时转发 → 临时群永不入档,既无废记录堆积,bye/失败回滚也无需清理。
  const direct = selectedModelByName.get(sessionName)
  if (direct) return direct
  const parent = tempProjectName(sessionName)
  return parent ? (selectedModelByName.get(parent) ?? null) : null
}

export function getSessionModel(sessionName: string): string | null {
  return selectedModelByName.get(sessionName)?.model ?? null
}

// ── Alive-on-shutdown marker ──────────────────────────────────────────
// Persists the list of session names that were still running when the
// daemon went down. Next boot reads the file and auto-spawns
// (via session.restart(true)) only those — sessions that were already
// `stop`ped before shutdown are deliberately NOT in this list, so they
// stay stopped after restart.

export function writeAliveMarker(sessionNames: string[]): void {
  try {
    writeFileSync(ALIVE_MARKER_FILE, JSON.stringify(sessionNames, null, 2))
  } catch (e) { log(`feishu: write alive marker failed: ${e}`) }
}

/** Read without unlinking. The daemon keeps this marker current while
 * running, so a rapid second restart cannot lose the revive list after
 * the first boot consumes it but exits before a clean shutdown. */
export function readAliveMarker(): string[] {
  if (!existsSync(ALIVE_MARKER_FILE)) return []
  try {
    const raw = readFileSync(ALIVE_MARKER_FILE, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch (e) {
    log(`feishu: read alive marker failed: ${e}`)
    return []
  }
}

export function chatIdForSession(sessionName: string): string | null {
  const preferred = preferredChatForSession.get(sessionName)
  if (preferred) {
    const cachedName = chatNameCache.get(preferred)
    if (cachedName && cachedName !== sessionName) {
      log(`feishu: chatIdForSession("${sessionName}"): persisted binding ${preferred} has cached name "${cachedName}", using persisted binding`)
    }
    return preferred
  }
  const matches: string[] = []
  for (const [id, name] of chatNameCache) if (name === sessionName) matches.push(id)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    log(`feishu: chatIdForSession("${sessionName}"): ${matches.length} candidates with no binding — [${matches.join(', ')}]`)
  }
  return null
}

export async function refreshChatList(): Promise<void> {
  try {
    let pageToken: string | undefined
    do {
      const res = await client.im.chat.list({
        params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      })
      for (const chat of res.data?.items ?? []) {
        if (chat.chat_id && chat.name) chatNameCache.set(chat.chat_id, chat.name)
      }
      pageToken = res.data?.page_token
    } while (pageToken)
    log(`feishu: refreshed chat list — ${chatNameCache.size} groups`)
  } catch (e) { log(`feishu: refresh chat list failed: ${e}`) }
}

export async function listNormalChatIdsByName(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  let pageToken: string | undefined
  do {
    const res = await client.im.chat.list({
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    })
    if (res.code && res.code !== 0) throw new Error(`feishu chat.list failed code=${res.code} msg=${res.msg}`)
    for (const chat of res.data?.items ?? []) {
      if (!chat.chat_id || !chat.name) continue
      if (chat.chat_status && chat.chat_status !== 'normal') continue
      chatNameCache.set(chat.chat_id, chat.name)
      const ids = out.get(chat.name) ?? []
      ids.push(chat.chat_id)
      out.set(chat.name, ids)
    }
    pageToken = res.data?.page_token
  } while (pageToken)
  return out
}

export async function findNormalChatIdByName(sessionName: string): Promise<string | null> {
  const cachedPreferred = preferredChatForSession.get(sessionName)
  if (cachedPreferred && chatNameCache.get(cachedPreferred) === sessionName) {
    const status = await fetchChatStatus(cachedPreferred)
    if (status.name === sessionName && isNormalChatStatus(status.status)) return cachedPreferred
    chatNameCache.delete(cachedPreferred)
    unbindSessionChat(sessionName)
  }
  const byName = await listNormalChatIdsByName()
  const matches = byName.get(sessionName) ?? []
  if (matches.length === 0) return null
  const preferred = preferredChatForSession.get(sessionName)
  if (preferred && matches.includes(preferred)) return preferred
  if (matches.length === 1) return matches[0]
  throw new Error(`multiple Feishu groups named "${sessionName}": ${matches.join(', ')}`)
}

export async function ensureChatForSession(sessionName: string, userOpenId: string): Promise<{ chatId: string; created: boolean; joined: boolean }> {
  if (!userOpenId) throw new Error('missing sender open_id; cannot add user to worktree group')
  const existing = await findNormalChatIdByName(sessionName)
  if (existing) {
    const joined = await ensureUserInChat(existing, userOpenId)
    bindSessionToChat(sessionName, existing)
    return { chatId: existing, created: false, joined }
  }

  const res = await client.im.chat.create({
    params: { user_id_type: 'open_id', uuid: randomUUID() },
    data: {
      name: sessionName,
      user_id_list: [userOpenId],
      group_message_type: 'chat',
    },
  })
  if (res.code && res.code !== 0) {
    throw new Error(`feishu chat.create failed code=${res.code} msg=${res.msg}`)
  }
  const chatId = res.data?.chat_id
  if (!chatId) throw new Error('feishu chat.create returned no chat_id')
  chatNameCache.set(chatId, sessionName)
  bindSessionToChat(sessionName, chatId)
  return { chatId, created: true, joined: true }
}

export async function disbandChatForSession(sessionName: string): Promise<{ chatId: string | null; disbanded: boolean }> {
  const chatId = await findNormalChatIdByName(sessionName)
  if (!chatId) {
    unbindSessionChat(sessionName)
    return { chatId: null, disbanded: false }
  }
  const res = await client.im.chat.delete({ path: { chat_id: chatId } })
  if (res.code && res.code !== 0) {
    throw new Error(`feishu chat.delete failed code=${res.code} msg=${res.msg}`)
  }
  chatNameCache.delete(chatId)
  unbindSessionChat(sessionName)
  return { chatId, disbanded: true }
}

async function ensureUserInChat(chatId: string, userOpenId: string): Promise<boolean> {
  let pageToken: string | undefined
  do {
    const res = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    })
    if (res.code && res.code !== 0) {
      throw new Error(`feishu chatMembers.get failed code=${res.code} msg=${res.msg}`)
    }
    for (const item of res.data?.items ?? []) {
      if (item.member_id === userOpenId) return false
    }
    pageToken = res.data?.page_token
  } while (pageToken)

  const add = await client.im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id' },
    data: { id_list: [userOpenId] },
  })
  if (add.code && add.code !== 0) {
    throw new Error(`feishu chatMembers.create failed code=${add.code} msg=${add.msg}`)
  }
  return true
}

/** Resolve ONE chat's name by chat_id via `im.chat.get`, bypassing the
 * eventually-consistent `im.chat.list` that {@link refreshChatList} walks.
 * A group the bot was just added to can lag the list endpoint by several
 * seconds — exactly the window in which the user fires their first message
 * — so a direct point-lookup is what lets a freshly-created group resolve
 * on the first try instead of bouncing off "无法识别群名". Caches the name
 * on hit. Returns null when the API errors OR the chat genuinely has no
 * name (an unnamed group — the caller must surface that, since group-name
 * → project-dir is load-bearing and an empty name can't map anywhere).
 * Raw fetch + tenant token, same shape as urgentApp / sendTextRaw. */
export async function fetchChatName(chatId: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: fetchChatName ${chatId} code=${json?.code} msg=${json?.msg}`)
      return null
    }
    const name = json.data?.name
    if (typeof name === 'string' && name) {
      chatNameCache.set(chatId, name)
      log(`feishu: fetchChatName ${chatId} → "${name}" (point lookup)`)
      return name
    }
    log(`feishu: fetchChatName ${chatId} — chat has no name (unnamed group?)`)
    return null
  } catch (e) {
    log(`feishu: fetchChatName ${chatId} failed: ${e}`)
    return null
  }
}

export * from './feishu-task'

// ── Outbound: text + card ──────────────────────────────────────────────
/** Retry delays for sendText/sendCard SDK calls. Three attempts total
 * (the leading 0 is the eager first try). Tuned for the bun+axios+lark-SDK
 * ECONNREFUSED transient we've been seeing — by ~5s the socket pool
 * usually recovers. Business errors (Feishu code != 0) are NOT retried;
 * only thrown network errors are. */
const SEND_RETRY_DELAYS_MS = [0, 1000, 4000]

async function sendViaSdkWithRetry(
  what: 'text' | 'card',
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string,
): Promise<string | null> {
  // Same uuid across retries → Feishu dedupes on its side so a successful-
  // but-response-lost first attempt doesn't produce a duplicate message.
  const uuid = randomUUID()
  let lastErr: unknown = null
  for (let i = 0; i < SEND_RETRY_DELAYS_MS.length; i++) {
    if (SEND_RETRY_DELAYS_MS[i] > 0) {
      await new Promise(r => setTimeout(r, SEND_RETRY_DELAYS_MS[i]))
    }
    try {
      const res: any = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content, uuid },
      })
      if (res?.code && res.code !== 0) {
        log(`feishu: send${what === 'text' ? 'Text' : 'Card'} rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
        return null
      }
      return res?.data?.message_id ?? null
    } catch (e) {
      lastErr = e
      log(`feishu: send${what === 'text' ? 'Text' : 'Card'} attempt ${i + 1}/${SEND_RETRY_DELAYS_MS.length} chat=${chatId} failed: ${e}`)
    }
  }
  log(`feishu: send${what === 'text' ? 'Text' : 'Card'} chat=${chatId} EXHAUSTED ${SEND_RETRY_DELAYS_MS.length} retries: ${lastErr}`)
  return null
}

async function fetchChatStatus(chatId: string): Promise<{ name: string | null; status: string | null }> {
  const res = await client.im.chat.get({ path: { chat_id: chatId } })
  if (res.code && res.code !== 0) {
    throw new Error(`feishu chat.get failed code=${res.code} msg=${res.msg}`)
  }
  return {
    name: res.data?.name ?? null,
    status: res.data?.chat_status ?? null,
  }
}

function isNormalChatStatus(status: string | null): boolean {
  return status === null || status === 'normal'
}

export async function sendText(chatId: string, text: string): Promise<string | null> {
  return sendViaSdkWithRetry('text', chatId, 'text', JSON.stringify({ text }))
}

export async function sendCard(chatId: string, card: object): Promise<string | null> {
  return sendViaSdkWithRetry('card', chatId, 'interactive', JSON.stringify(card))
}

export async function updateCard(messageId: string, card: object): Promise<void> {
  const res: any = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  })
  if (res?.code && res.code !== 0) {
    throw new Error(`feishu message.patch failed code=${res.code} msg=${res.msg}`)
  }
}

/** Last-resort text send that bypasses the lark SDK and uses raw fetch
 * (which is what cardkit.ts uses and has never had stability issues on
 * this runtime). Used by callers that need to *surface a failure when
 * the SDK send path itself is the broken thing* — e.g. `openTurnCard`'s
 * `sendCard` exhausted retries on ECONNREFUSED and we still owe the
 * user a visible "your message was lost, please retry" notice. Do not
 * use this as a general-purpose send; it's the failure-surfacing
 * channel, not a silent fallback. */
export async function sendTextRaw(chatId: string, text: string): Promise<string | null> {
  try {
    const token = await getTenantToken()
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: sendTextRaw rejected chat=${chatId} code=${json?.code} msg=${json?.msg}`)
      return null
    }
    return json.data?.message_id ?? null
  } catch (e) {
    log(`feishu: sendTextRaw chat=${chatId} failed: ${e}`)
    return null
  }
}

// ── Reactions ──────────────────────────────────────────────────────────
/** Add an emoji reaction. Returns the new reaction_id on success (needed
 * to delete the reaction later via {@link deleteReaction}) or null on
 * failure. Failures are logged and swallowed — reactions are non-load-
 * bearing UX, not worth bubbling errors. */
export async function addReaction(messageId: string, emojiType: string): Promise<string | null> {
  if (!messageId) return null
  try {
    const res: any = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    return res?.data?.reaction_id ?? null
  } catch (e) { log(`feishu: addReaction ${emojiType} on ${messageId} failed: ${e}`); return null }
}

/** Remove a previously-added reaction by its reaction_id (returned from
 * {@link addReaction}). Used for the "queued → released" lifecycle: the
 * OneSecond placed on arrival is *removed* when the daemon hands the
 * message off to the SDK's batch / system-reminder pipeline, instead of
 * stacking a second CheckMark on top — keeps the message's reaction row
 * uncluttered. Quiet on failure. */
export async function deleteReaction(messageId: string, reactionId: string): Promise<void> {
  if (!messageId || !reactionId) return
  try {
    await client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })
  } catch (e) { log(`feishu: deleteReaction ${reactionId} on ${messageId} failed: ${e}`) }
}

// ── Urgent push ───────────────────────────────────────────────────────
/** Fire Feishu's "加急 — 应用内" push for an already-sent message.
 * Bypasses chat-level mute and pops a full-screen prompt on the
 * recipient's phone. Bot must be the original sender of the message
 * AND must still be a member of the chat.
 *
 * Endpoint:
 *   PATCH /open-apis/im/v1/messages/{message_id}/urgent_app
 *   ?user_id_type=open_id
 *   body: { user_id_list: ["ou_..."] }
 *
 * Required app scope (either one):
 *   - `im:message.urgent`            (「发送应用内加急消息」)
 *   - `im:message.urgent:app_send`   (「…（历史版本）」)
 *
 * Limits: 50 QPS app-wide; per-recipient cap is 200 unread urgent
 * messages (230023). No daily quota.
 *
 * Common error codes:
 *   230012 — message not sent by this bot
 *   230023 — recipient has 200 unread urgent already
 *   230052 — missing scope / chat restricts urgent */
export async function urgentApp(messageId: string, openIds: string[]): Promise<void> {
  if (!messageId) { log(`feishu: urgentApp skip — missing messageId`); return }
  if (openIds.length === 0) { log(`feishu: urgentApp skip — empty openIds (msg=${messageId})`); return }
  const token = await getTenantToken()
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/urgent_app?user_id_type=open_id`
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id_list: openIds }),
    })
    const json = await res.json() as any
    if (json?.code !== 0) {
      log(`feishu: urgentApp ${messageId} code=${json?.code} msg=${json?.msg}`)
      return
    }
    const invalid = json.data?.invalid_user_id_list ?? []
    const delivered = openIds.length - invalid.length
    log(`feishu: urgentApp ${messageId} ok — delivered=${delivered}${invalid.length ? ` invalid=${invalid.length}` : ''}`)
  } catch (e) { log(`feishu: urgentApp ${messageId} failed: ${e}`) }
}

// ── Attachment download (image/file) ───────────────────────────────────
export async function downloadAttachment(
  messageId: string, key: string, type: 'image' | 'file', name?: string,
): Promise<string | undefined> {
  try {
    const token = await getTenantToken()
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      log(`feishu: download ${type} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return undefined
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const safeName = name
      ? name.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
    const path = join(INBOX_DIR, `${Date.now()}-${safeName}`)
    writeFileSync(path, buf)
    log(`feishu: downloaded ${type} ${path} (${buf.length}B)`)
    return path
  } catch (e) {
    log(`feishu: download ${type} failed: ${e instanceof Error ? e.message : e}`)
    return undefined
  }
}

// ── Outbound: upload + send file/image ────────────────────────────────
// Lark caps message images at ~30 MB; files vary by tenant (default 30 MB).
// We refuse anything above 30 MB up front rather than chasing per-tenant
// limits and surfacing opaque API errors mid-upload.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])

function looksLikeImage(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase())
}

async function uploadImageMultipart(filePath: string): Promise<string | null> {
  const token = await getTenantToken()
  const file = new Blob([await readFile(filePath)])
  const form = new FormData()
  form.append('image_type', 'message')
  form.append('image', file, basename(filePath))
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json() as any
  if (data?.code !== 0) {
    log(`feishu: uploadImage ${filePath} code=${data.code} msg=${data.msg}`)
    return null
  }
  return data.data?.image_key ?? null
}

/** Upload a local image for embedding inside a Card Kit card. Returns the
 * Feishu-accessible `image_key`, or null on any failure (missing/oversize
 * file, API rejection). Mirrors `uploadAndSend`'s validation but yields the
 * key so the caller can place an `{tag:'image'}` element instead of sending
 * a standalone image message. */
export async function uploadImageKey(filePath: string): Promise<string | null> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      log(`feishu: uploadImageKey not a file — ${filePath}`)
      return null
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      log(`feishu: uploadImageKey oversize — ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      return null
    }
  } catch (e) {
    log(`feishu: uploadImageKey stat failed — ${filePath}: ${e}`)
    return null
  }
  return uploadImageMultipart(filePath)
}

async function uploadFileMultipart(filePath: string): Promise<string | null> {
  const token = await getTenantToken()
  const file = new Blob([await readFile(filePath)])
  const form = new FormData()
  // 'stream' is the catch-all type and works for arbitrary binaries.
  form.append('file_type', 'stream')
  form.append('file_name', basename(filePath))
  form.append('file', file, basename(filePath))
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const data = await res.json() as any
  if (data?.code !== 0) {
    log(`feishu: uploadFile ${filePath} code=${data.code} msg=${data.msg}`)
    return null
  }
  return data.data?.file_key ?? null
}

export async function sendImage(chatId: string, imageKey: string): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendImage rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendImage failed chat=${chatId}: ${e}`); return null }
}

export async function sendFile(chatId: string, fileKey: string): Promise<string | null> {
  try {
    const res: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    })
    if (res?.code && res.code !== 0) {
      log(`feishu: sendFile rejected chat=${chatId} code=${res.code} msg=${res.msg}`)
      return null
    }
    return res?.data?.message_id ?? null
  } catch (e) { log(`feishu: sendFile failed chat=${chatId}: ${e}`); return null }
}

/** Upload a local file and post it as an image or file message in the
 * chat.  Type is inferred from extension.  Returns true on success.
 * All failures (missing file, oversize, upload reject, send reject)
 * log and surface an inline error message in the chat so the user
 * knows. */
export async function uploadAndSend(chatId: string, filePath: string): Promise<boolean> {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      await sendText(chatId, `❌ 出站文件: 路径不是文件 — ${filePath}`)
      return false
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      await sendText(chatId, `❌ 出站文件: ${basename(filePath)} 超过 30 MB (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
      return false
    }
  } catch (e) {
    await sendText(chatId, `❌ 出站文件: 无法读取 ${filePath} (${e})`)
    return false
  }
  const isImage = looksLikeImage(filePath)
  try {
    if (isImage) {
      const key = await uploadImageMultipart(filePath)
      if (!key) { await sendText(chatId, `❌ 出站图片上传失败: ${basename(filePath)}`); return false }
      const msgId = await sendImage(chatId, key)
      return msgId != null
    } else {
      const key = await uploadFileMultipart(filePath)
      if (!key) { await sendText(chatId, `❌ 出站文件上传失败: ${basename(filePath)}`); return false }
      const msgId = await sendFile(chatId, key)
      return msgId != null
    }
  } catch (e) {
    log(`feishu: uploadAndSend ${filePath} failed: ${e}`)
    await sendText(chatId, `❌ 出站文件异常: ${basename(filePath)} — ${e}`)
    return false
  }
}

// ── Project provisioning ──────────────────────────────────────────────
// Bootstrap ~/{name}: create dir, mark as trusted in ~/.codex/config.toml so
// Codex skips the project trust dialog, and `git init` so the project starts as
// a real repo.
export function provisionProject(workDir: string): void {
  mkdirSync(workDir, { recursive: true })
  log(`feishu: provisioned ${workDir}`)
  const codexConfigPath = join(homedir(), '.codex', 'config.toml')
  try {
    mkdirSync(join(homedir(), '.codex'), { recursive: true })
    let text = ''
    try { text = readFileSync(codexConfigPath, 'utf8') } catch {}
    const header = `[projects.${JSON.stringify(workDir)}]`
    if (!text.includes(header)) {
      const prefix = text.trimEnd()
      text = `${prefix}${prefix ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`
      writeFileSync(codexConfigPath, text)
    }
  } catch (e) { log(`feishu: codex trust write failed for ${workDir}: ${e}`) }
  try { execSync('git init -q', { cwd: workDir, stdio: 'ignore' }) } catch {}
}

export function isOpenAIChatGPTAuthenticated(): boolean {
  try {
    const out = execSync(`"${resolveCodexBin()}" login status 2>&1`, { timeout: 10_000 }).toString()
    return /Logged in using ChatGPT/i.test(out)
  } catch { return false }
}

export function sanitizeSessionName(raw: string): string {
  // `*` 给临时群后缀(*MMDD-HHMM)用,和 worktree 的 `[]` 一样显式放行。
  return raw.replace(/[^\w一-鿿\-\[\]\*]/g, '_').slice(0, 64)
}
