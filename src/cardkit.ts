/**
 * Feishu Card Kit v1 wrapper.
 *
 * Endpoints used (base = https://open.feishu.cn/open-apis/cardkit/v1):
 *   POST   /cards/id_convert                              message_id → card_id
 *   POST   /cards                                         create a card entity
 *   POST   /cards/:card_id/elements                       add element
 *   PUT    /cards/:card_id/elements/:element_id           replace element
 *   DELETE /cards/:card_id/elements/:element_id           remove element
 *   PATCH  /cards/:card_id/settings                       toggle streaming_mode etc.
 *
 * Per-card invariants enforced here:
 *   - `sequence` is monotonically increasing per card_id
 *   - all writes for a card are serialized through a Promise queue
 */

import { getTenantToken } from './feishu'
import { log } from './log'
import { neutralizeMarkdownImagesInCard } from './cards/elements'

const BASE = 'https://open.feishu.cn/open-apis/cardkit/v1'
const CARDKIT_FETCH_TIMEOUT_MS = 15_000

const ID_CONVERT_RETRY_DELAYS_MS = [0, 250, 750, 1500]

interface CardState {
  sequence: number
  queue: Promise<void>
  /** Live count of elements on the card. Initialised by
   * `recordCardCreated` (session passes the body.elements.length of the
   * just-sent card), then incremented in addElement's success branch and
   * decremented in deleteElement's. Used by session to pre-empt the
   * Card Kit component-count ceiling (300305, sometimes nested in 300315)
   * — once
   * the count climbs into the danger zone, session rotates a new card
   * mid-turn before the next addElement would 400. Approximate (a failed
   * addElement won't bump it, so the count tracks "elements Feishu
   * believes exist" not "elements we tried to create"). */
  elementCount: number
  /** element_ids that must no longer receive writes. Usually this means
   * `addElement` was rejected by Feishu, so the element does NOT exist on Feishu's
   * side and every subsequent `replaceElement`/`deleteElement`
   * would 300313/300121. Per-card and dropped on `dispose`, so a rotated-to
   * fresh card starts clean. */
  deadElements: Set<string>
  /** Card-level write kill-switch (see markCardWriteDead). Once set, every
   * write op short-circuits to a resolved promise — no HTTP, no onFailure.
   * Session flips this when it hits the failure-rotate cap and goes
   * log-only: without it, the per-second footer ticker and stream handlers
   * keep hammering the unwritable card (2026-07-04: 663 × code=300308 in
   * 11 minutes against one dead card). */
  writeDead?: boolean
  /** Synchronous enqueue gate set by dispose before draining the queue. */
  closing?: boolean
  /** Card-level write-failure callback, set by recordCardCreated. Invoked
   * by any cardkit write op that fails even after the streaming-closed
   * reopen+retry; the session uses it to rotate onto a fresh card (see
   * Session.onCardWriteFailure). Not fired for deletes (a failed delete is
   * harmless — it doesn't block new content). */
  onFailure?: (code?: number, failure?: CardWriteFailure) => void
}

export interface CardWriteFailure {
  cardId: string
  operation: string
  elementId?: string
  targetElementId?: string
  code?: number
  httpStatus?: number
  logId?: string
  message: string
}

export interface CardWriteResult {
  landed: boolean
  failure?: CardWriteFailure
}

interface CardKitRequestError extends Error {
  code?: number
  httpStatus?: number
  logId?: string
}

/** `300305` is the actual component-count ceiling. `300315` only means
 * "failed to add element" and also wraps deterministic payload failures
 * such as duplicate/invalid element IDs (`300301`). Only classify a
 * `300315` as card-full when its nested diagnostic explicitly names
 * `300305` or an element/component count overflow. */
export function isElementLimitFailure(
  code?: number,
  failure?: Pick<CardWriteFailure, 'message'>,
): boolean {
  if (code === 300305) return true
  if (code !== 300315) return false
  const message = failure?.message ?? ''
  return /(?:code\s*[:=]\s*300305\b|number of card components[^\n.]{0,60}exceed)/i.test(message)
}

export function isDuplicateElementFailure(
  code?: number,
  failure?: Pick<CardWriteFailure, 'message'>,
): boolean {
  if (code !== 300315) return false
  return /(?:duplicate\s+(?:element\s*)?id|code\s*1001\s*:\s*duplicate id)/i
    .test(failure?.message ?? '')
}

const cards = new Map<string, CardState>()

interface SummaryState {
  latest: string
  lastSent: string
  timer: ReturnType<typeof setTimeout> | null
}
const summaryStates = new Map<string, SummaryState>()
const SUMMARY_FLUSH_MS = 1500

function state(cardId: string): CardState {
  let s = cards.get(cardId)
  if (!s) {
    s = {
      sequence: 0,
      queue: Promise.resolve(),
      elementCount: 0,
      deadElements: new Set(),
    }
    cards.set(cardId, s)
  }
  return s
}

/** Card ids that were disposed (turn closed / rotated away). Mutation APIs
 *  on a disposed card must NOT silently re-create state via state() and fire
 *  real HTTP writes at a card whose stream is closed — that both pollutes
 *  the wire and resurrects leaked state. Checked callers observe false /
 *  no-op instead (review #3). */
const disposedCards = new Set<string>()
const MAX_DISPOSED_CARD_TOMBSTONES = 5000

function rememberDisposedCard(cardId: string): void {
  disposedCards.delete(cardId)
  disposedCards.add(cardId)
  while (disposedCards.size > MAX_DISPOSED_CARD_TOMBSTONES) {
    const oldest = disposedCards.values().next().value
    if (typeof oldest !== 'string') break
    disposedCards.delete(oldest)
  }
}

/** True if this card was disposed. Late async writers (math render promises
 *  landing after turn close) check this before scheduling writes. */
export function isDisposed(cardId: string): boolean {
  return disposedCards.has(cardId)
}

/** Session calls this once right after sendCard + convertMessageToCard,
 * passing the number of elements that were in the card's initial body
 * (banner + userInputPanel + footer = 1–3 depending on turn
 * kind). Without this, the element-count tracker only sees adds/deletes
 * that happen *after* card creation, and session can't reliably decide
 * "is this card close to the limit?" — that's the data point that
 * triggers a mid-turn rotate before a confirmed `300305` capacity error. */
export function recordCardCreated(
  cardId: string,
  initialElementCount: number,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): void {
  // 新生命周期开始:同 id 重建(测试复用固定 card id / 飞书同 id 再开卡)
  // 时清除 disposed 标记,恢复可写。
  disposedCards.delete(cardId)
  cards.delete(cardId)
  const s = state(cardId)
  s.elementCount = initialElementCount
  s.onFailure = onFailure
  s.writeDead = false
  s.closing = false
}

/** Read the live element count maintained by addElement/deleteElement.
 * Returns 0 if the card has no state yet (which is also the right answer
 * for "this card has no elements that we know about"). */
export function getElementCount(cardId: string): number {
  return cards.get(cardId)?.elementCount ?? 0
}

/** True if `elementId` was recorded dead on this card (its addElement was
 * rejected, so the element doesn't exist on Feishu). Mid-turn rotation reads
 * this for tool panels: dead ⇒ rebuild on the fresh card, alive ⇒ leave it on
 * the old card. */
export function isDeadElement(cardId: string, elementId: string): boolean {
  return cards.get(cardId)?.deadElements.has(elementId) ?? false
}

/** A duplicate-id add may mean the element landed but the acknowledgement
 * was lost/raced. Allow one checked PUT reconciliation against that id. */
export function clearDeadElementForReconcile(cardId: string, elementId: string): void {
  cards.get(cardId)?.deadElements.delete(elementId)
}

/** Stop all future writes to this card. Idempotent; cleared only by
 * dispose (a rotated-to fresh card has its own state). Covers both new
 * enqueues and already-queued tasks that haven't reached the wire yet
 * (each op re-checks the flag when it runs). */
export function markCardWriteDead(cardId: string): void {
  if (disposedCards.has(cardId)) return
  const s = state(cardId)
  if (s.closing) return
  s.writeDead = true
  cancelSummary(cardId)
}

function nextSeq(cardId: string): number {
  const s = state(cardId)
  s.sequence += 1
  return s.sequence
}

function markElementDead(s: CardState, elementId: string): void {
  s.deadElements.add(elementId)
}

async function call(method: string, path: string, body?: object): Promise<any> {
  const token = await getTenantToken()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(CARDKIT_FETCH_TIMEOUT_MS),
  })
  const json = await res.json() as any
  if (!res.ok || json?.code !== 0) {
    const code = typeof json?.code === 'number' ? json.code : res.status
    const logId = res.headers.get('x-tt-logid') ?? res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined
    const e = new Error(
      `cardkit ${method} ${path}: HTTP ${res.status} code=${String(json?.code ?? 'MISS')} msg=${json?.msg ?? 'MISS'}${logId ? ` log_id=${logId}` : ''}`,
    ) as CardKitRequestError
    e.code = code
    e.httpStatus = res.status
    e.logId = logId
    throw e
  }
  return json?.data
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isStreamingClosed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const code = (e as any).code
  // 300309 "streaming mode is closed" — TTL already fired before our write.
  // 200850 "card streaming timeout"   — TTL fired exactly during our write.
  // Both mean the streaming session is gone and a reopen will unstick the card.
  return code === 300309 || code === 200850
}

/** Reopen streaming_mode on a card that Feishu auto-closed after its
 * 10-minute streaming TTL (no keepalive, no idle reset — the timer
 * starts when streaming is opened and fires regardless of activity).
 * Called from inside the per-card queue's catch path, so it allocates
 * its own sequence and runs inline without re-enqueueing. */
async function reopenStreaming(cardId: string): Promise<void> {
  const seq = nextSeq(cardId)
  await call('PATCH', `/cards/${cardId}/settings`, {
    settings: JSON.stringify({ config: { streaming_mode: true } }),
    sequence: seq,
  })
}

/** Run `op` inside the per-card queue. If it fails with code=300309
 * or 200850 (Feishu auto-closed / timed-out streaming after the 10-
 * minute TTL), reopen streaming inline and retry `op` exactly once.
 * Anything else — other failure, reopen failure, retry failure — is
 * logged and swallowed, matching the fire-and-forget contract every
 * cardkit op already has at the call sites. */
async function withReopenOnStreamingClosed(
  cardId: string,
  label: string,
  op: () => Promise<void>,
  onFailure?: (failure: CardWriteFailure) => void,
  silent = false,
  meta: Pick<CardWriteFailure, 'elementId' | 'targetElementId'> = {},
): Promise<void> {
  // 失败统一出口:card-level handler 先(它同步快照当前段/tool 后再异步
  // 换卡),per-call onFailure 后(addElement 的 deadElements.add + session
  // 段游标 reset)。顺序要紧 —— 换卡的同步快照必须在 reset 把
  // currentAssistant* 清空之前跑。silent(deleteElement)跳过 card-level:
  // 删不掉一个元素不影响新内容,不值得为它换卡。
  const fail = (error: unknown): void => {
    const requestError = typeof error === 'object' && error !== null
      ? error as CardKitRequestError
      : null
    const failure: CardWriteFailure = {
      cardId,
      operation: label,
      ...meta,
      code: requestError?.code,
      httpStatus: requestError?.httpStatus,
      logId: requestError?.logId,
      message: error instanceof Error ? error.message : String(error),
    }
    try {
      if (!silent) state(cardId).onFailure?.(failure.code, failure)
    } catch (error) {
      log(`cardkit failure callback ${cardId}: ${error}`)
    }
    try {
      onFailure?.(failure)
    } catch (error) {
      log(`cardkit per-call failure callback ${cardId}: ${error}`)
    }
  }
  try {
    await op()
    return
  } catch (e) {
    if (!isStreamingClosed(e)) {
      log(`cardkit ${label} ${cardId}: ${e}`)
      fail(e)
      return
    }
    log(`cardkit ${label} ${cardId}: streaming closed (code=${(e as any).code}) — reopening`)
  }
  try {
    await reopenStreaming(cardId)
  } catch (re) {
    log(`cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re}`)
    fail(re)
    return
  }
  try {
    await op()
  } catch (e2) {
    log(`cardkit ${label} ${cardId} retry-after-reopen: ${e2}`)
    fail(e2)
  }
}

function isIdConvertEmptyResult(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as any).code === 200740
}

interface IdConvertOptions {
  retryDelaysMs?: number[]
}

/** Convert a sent interactive message into a card entity. */
export async function convertMessageToCard(
  messageId: string,
  opts: IdConvertOptions = {},
): Promise<string> {
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : ID_CONVERT_RETRY_DELAYS_MS
  let lastErr: unknown = null
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i] ?? 0
    if (delay > 0) await sleep(delay)
    try {
      const data = await call('POST', '/cards/id_convert', { message_id: messageId })
      if (typeof data?.card_id !== 'string' || !data.card_id) {
        throw new Error(`cardkit POST /cards/id_convert: missing card_id`)
      }
      return data.card_id
    } catch (e) {
      lastErr = e
      if (!isIdConvertEmptyResult(e) || i === delays.length - 1) throw e
      const nextDelay = delays[i + 1] ?? 0
      log(`cardkit id_convert ${messageId}: empty result, retry ${i + 2}/${delays.length} in ${nextDelay}ms`)
    }
  }
  throw lastErr
}

/** Create a card entity from raw schema-2.0 card JSON. */
export async function createCardEntity(card: object): Promise<string> {
  const safeCard = neutralizeMarkdownImagesInCard(card)
  const data = await call('POST', '/cards', {
    type: 'card_json',
    data: JSON.stringify(safeCard),
  })
  return data.card_id
}

/** Wait for all currently queued writes for a card. */
export async function flush(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) return
  await s.queue
}

/** Add a new element to the card body or relative to a sibling.
 *
 * `onFailure` fires asynchronously (after promise queue settles) if the
 * element was NOT created — either the first attempt failed with a non-
 * 300309 error, or the retry-after-reopen also failed. Use it to invalidate
 * any daemon-side reference to the element you tried to add (e.g. a segment
 * id), so subsequent writes don't keep PUTting content to a phantom element
 * that Feishu will silently reject. Default (no callback) preserves the
 * legacy fire-and-forget swallow behavior. */
export function addElement(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): Promise<void> {
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing || s.writeDead) return Promise.resolve()
  const safeElement = neutralizeMarkdownImagesInCard(element)
  const elementId = (safeElement as { element_id?: string }).element_id
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `addElement`,
    async () => {
      if (s.writeDead) return
      const seq = nextSeq(cardId)
      await call('POST', `/cards/${cardId}/elements`, {
        type: opts.type ?? 'append',
        ...(opts.targetElementId ? { target_element_id: opts.targetElementId } : {}),
        elements: JSON.stringify([safeElement]),
        sequence: seq,
      })
      // Only bump after the API returns 0 — any rejected add will
      // bypass this line, so the count tracks "elements Feishu actually
      // accepted" not "elements we tried to push".
      s.elementCount += 1
      if (elementId) s.deadElements.delete(elementId)
    },
    (failure) => {
      // Add rejected ⇒ this element_id does not exist on Feishu's side.
      // Mark it dead so subsequent replace/delete aimed at it
      // short-circuit instead of spraying 300313/300121. Then forward the
      // structured failure: session rotates only a confirmed 300305 capacity
      // error. Validation/content failures keep the current card and preserve
      // this element as dead.
      if (elementId) markElementDead(s, elementId)
      onFailure?.(failure.code, failure)
    },
    false,
    { elementId, targetElementId: opts.targetElementId },
  ))
  return s.queue
}

/** Replace an entire element (used to swap a tool placeholder with its result). */
export function replaceElement(
  cardId: string,
  elementId: string,
  element: object,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
  notifyCardFailure = true,
): Promise<void> {
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing || s.writeDead || s.deadElements.has(elementId)) return Promise.resolve()
  const safeElement = neutralizeMarkdownImagesInCard(element)
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `replaceElement ${elementId}`,
    async () => {
      if (s.writeDead || s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
        element: JSON.stringify(safeElement),
        sequence: seq,
      })
    },
    failure => onFailure?.(failure.code, failure),
    !notifyCardFailure,
    { elementId },
  ))
  return s.queue
}

/** Checked variants for callers that must know whether the write actually
 *  landed (math render: only mark a segment "rendered" when every write
 *  succeeded — a false marker would swallow the formula entirely, review #4).
 *  Resolves false on: card disposed, card write-dead, element dead, or the
 *  API call failing after retries. Never throws. */
export async function replaceElementChecked(
  cardId: string,
  elementId: string,
  element: object,
  opts: { notifyCardFailure?: boolean } = {},
): Promise<boolean> {
  if (disposedCards.has(cardId)) return false
  const s = state(cardId)
  if (s.closing || s.writeDead || s.deadElements.has(elementId)) return false
  let failed = false
  await replaceElement(
    cardId,
    elementId,
    element,
    () => { failed = true },
    opts.notifyCardFailure !== false,
  )
  return !failed && !s.writeDead && !s.deadElements.has(elementId)
}

export async function addElementChecked(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
): Promise<boolean> {
  return (await addElementResult(cardId, element, opts)).landed
}

export async function addElementResult(
  cardId: string,
  element: object,
  opts: { type?: 'append' | 'insert_before' | 'insert_after'; targetElementId?: string } = {},
): Promise<CardWriteResult> {
  if (disposedCards.has(cardId)) return { landed: false }
  const s = state(cardId)
  if (s.closing || s.writeDead) return { landed: false }
  const elementId = (element as { element_id?: string }).element_id
  let failure: CardWriteFailure | undefined
  await addElement(cardId, element, opts, (_code, detail) => { failure = detail })
  return {
    landed: !failure && !s.writeDead && !(elementId && s.deadElements.has(elementId)),
    ...(failure ? { failure } : {}),
  }
}

/** Delete an element by id. */
export function deleteElement(
  cardId: string,
  elementId: string,
  onFailure?: (code?: number, failure?: CardWriteFailure) => void,
): Promise<void> {
  if (disposedCards.has(cardId)) return Promise.resolve()
  const s = state(cardId)
  if (s.closing || s.writeDead || s.deadElements.has(elementId)) return Promise.resolve()
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    `deleteElement ${elementId}`,
    async () => {
      if (s.writeDead || s.deadElements.has(elementId)) return
      const seq = nextSeq(cardId)
      await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
        sequence: seq,
      })
      s.elementCount = Math.max(0, s.elementCount - 1)
      markElementDead(s, elementId)
    },
    failure => onFailure?.(failure.code, failure),
    true,
    { elementId },
  ))
  return s.queue
}

export async function deleteElementChecked(cardId: string, elementId: string): Promise<boolean> {
  if (disposedCards.has(cardId)) return false
  const s = state(cardId)
  if (s.closing || s.writeDead) return false
  if (s.deadElements.has(elementId)) return true
  let failed = false
  await deleteElement(cardId, elementId, () => { failed = true })
  return !failed && s.deadElements.has(elementId)
}

/** Throttled card-summary update. The summary text is what Feishu shows
 * in the chat list as the message preview. We coalesce writes on a
 * SUMMARY_FLUSH_MS window so assistant deltas don't blow up
 * the settings-PATCH endpoint. Whitespace is collapsed and the input
 * is trimmed; empty content is ignored. */
export function patchSummaryThrottled(cardId: string, content: string): void {
  if (disposedCards.has(cardId) || cards.get(cardId)?.closing || cards.get(cardId)?.writeDead) return
  const trimmed = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return
  let s = summaryStates.get(cardId)
  if (!s) {
    s = { latest: trimmed, lastSent: '', timer: null }
    summaryStates.set(cardId, s)
  } else {
    s.latest = trimmed
  }
  if (s.timer) return
  s.timer = setTimeout(() => {
    const st = summaryStates.get(cardId)
    if (!st) return
    if (disposedCards.has(cardId)) { summaryStates.delete(cardId); return }
    st.timer = null
    if (st.latest === st.lastSent) return
    const toSend = st.latest
    void patchSettingsChecked(cardId, { config: { summary: { content: toSend } } })
      .then(landed => {
        const current = summaryStates.get(cardId)
        if (landed && current === st) current.lastSent = toSend
      })
  }, SUMMARY_FLUSH_MS)
}

/** Cancel any pending throttled summary write. Call before emitting
 * a terminal summary (e.g. "✅ ⏱ 12.3s · 4.2K tokens") so a stale
 * in-flight update can't fire after and clobber the final preview. */
export function cancelSummary(cardId: string): void {
  const s = summaryStates.get(cardId)
  if (!s) return
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  summaryStates.delete(cardId)
}

/** Patch settings — used to flip streaming_mode off when a turn finishes.
 *
 * `nextSeq` is called inside the queued task (not at enqueue time) to
 * match addElement/replaceElement/deleteElement above. Mixing
 * call-time and execution-time seq allocation interleaves badly: a
 * patchSettings enqueued right after a replaceElement would grab the
 * smaller seq number, but the replaceElement's then-block would grab
 * the larger one when it ran first, so the patchSettings PATCH lands
 * with a stale seq and Feishu rejects 300317 "sequence number compare
 * failed". Keeping all writes on execution-time allocation makes the
 * seq order match the queue order. */
export function patchSettings(cardId: string, settings: object): Promise<void> {
  return patchSettingsChecked(cardId, settings).then(() => {})
}

/** Checked settings mutation for terminal/static-card transactions. Unlike
 * the legacy fire-and-forget wrapper, callers can distinguish a landed PATCH
 * from a timeout/rejection and must not dispose bookkeeping on false. */
export async function patchSettingsChecked(cardId: string, settings: object): Promise<boolean> {
  if (disposedCards.has(cardId)) return false
  const s = state(cardId)
  if (s.closing || s.writeDead) return false
  let landed = false
  let failed = false
  s.queue = s.queue.then(() => withReopenOnStreamingClosed(
    cardId,
    'patchSettings',
    async () => {
      if (disposedCards.has(cardId) || s.writeDead) return
      const seq = nextSeq(cardId)
      await call('PATCH', `/cards/${cardId}/settings`, {
        settings: JSON.stringify(settings),
        sequence: seq,
      })
      landed = true
    },
    () => { failed = true },
    true,
  ))
  await s.queue
  return landed && !failed && !disposedCards.has(cardId) && !s.writeDead
}

/** Drop in-memory bookkeeping for a finished card. */
export async function dispose(cardId: string): Promise<void> {
  const s = cards.get(cardId)
  if (!s) {
    rememberDisposedCard(cardId)
    cancelSummary(cardId)
    return
  }
  if (s.closing) {
    await s.queue
    return
  }
  // Close the enqueue gate synchronously. Operations already in s.queue are
  // allowed to finish; later callers observe closing and cannot extend it.
  s.closing = true
  cancelSummary(cardId)
  await s.queue
  rememberDisposedCard(cardId)
  cards.delete(cardId)
}
