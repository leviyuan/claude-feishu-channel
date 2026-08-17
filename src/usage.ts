/**
 * ChatGPT/Codex usage snapshot for the `hi` console panel.
 *
 * Source: Codex app-server `account/read` + `account/rateLimits/read`.
 * This stays on the same auth path as the daemon itself: the user's
 * local `codex login` ChatGPT session.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveCodexBin } from './codex-process'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export interface UsageWindow {
  percent: number | null
  resetsAt: Date | null
  durationMins?: number | null
}

export type UsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'auth_failed' }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      subscriptionType?: string
      fiveHour: UsageWindow | null
      weekly: UsageWindow | null
      fetchedAt: number
    }

type UsageSnapshotOk = Extract<UsageSnapshot, { state: 'ok' }>

let cache: UsageSnapshot | null = null
let inFlight: Promise<UsageSnapshot> | null = null

export class AppServerOnce {
  private proc: ChildProcessByStdio<Writable, Readable, Readable>
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()

  constructor() {
    this.proc = spawn(resolveCodexBin(), ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }) as ChildProcessByStdio<Writable, Readable, Readable>
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString().trim()
      if (s) log(`usage[codex stderr]: ${s}`)
    })
    this.proc.on('exit', (code, signal) => {
      for (const [id, p] of this.pending) {
        p.reject(new Error(`codex app-server exited before ${p.method} response id=${id} code=${code} signal=${signal}`))
      }
      this.pending.clear()
    })
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString()
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (!Object.prototype.hasOwnProperty.call(msg, 'id')) continue
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)))
      else pending.resolve(msg.result)
    }
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++
    this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
  }

  async close(): Promise<void> {
    try { this.proc.kill('SIGTERM') } catch {}
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function windowFromRateLimit(w: any): UsageWindow | null {
  if (!w) return null
  return {
    percent: clampPct(w.usedPercent),
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000) : null,
    durationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
  }
}

/** 窗口归类:codex 不保证 primary/secondary 位置语义 —— Prolite 等套餐把
 * 唯一的周窗口塞在 primary(secondary=null),Plus/Pro 才是 primary=5h +
 * secondary=周。按 windowDurationMins 真实时长归类(300→5h,10080→周),
 * 位置只作 fallback(时长缺失时)。 */
function classifyWindows(limits: any): { fiveHour: UsageWindow | null; weekly: UsageWindow | null } {
  const primary = windowFromRateLimit(limits?.primary)
  const secondary = windowFromRateLimit(limits?.secondary)
  const byDuration = (w: UsageWindow | null, mins: number): boolean =>
    w?.durationMins === mins
  if (byDuration(primary, 10_080) && byDuration(secondary, 300)) {
    // 未见过的倒挂形态(primary=周、secondary=5h),按时长纠正
    return { fiveHour: secondary, weekly: primary }
  }
  if (byDuration(primary, 10_080) && !secondary) {
    // Prolite 形态:唯一的周窗口在 primary
    return { fiveHour: null, weekly: primary }
  }
  if (byDuration(primary, 300) || (!primary?.durationMins && primary)) {
    // 常规 Plus/Pro:primary=5h;或时长缺失按位置
    return { fiveHour: primary, weekly: secondary }
  }
  // primary 是其他时长(如自定义 individualLimit):按位置保守处理
  return { fiveHour: primary, weekly: secondary }
}


export function updateUsageFromRateLimits(rateLimits: any): UsageSnapshot {
  if (!rateLimits) return cache ?? { state: 'network', reason: 'empty rate limit update' }
  const snapshot: UsageSnapshotOk = {
    state: 'ok',
    subscriptionType: rateLimits.planType,
    ...classifyWindows(rateLimits),
    fetchedAt: Date.now(),
  }
  cache = snapshot
  return snapshot
}

async function fetchUsage(): Promise<UsageSnapshot> {
  const app = new AppServerOnce()
  try {
    await withTimeout(app.request('initialize', {
      clientInfo: { name: 'lodestar-usage', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }), API_TIMEOUT_MS)

    const accountRes = await withTimeout(app.request('account/read', {}), API_TIMEOUT_MS)
    const account = accountRes?.account
    if (!account) return { state: 'no_credentials' }
    if (account.type !== 'chatgpt') return { state: 'auth_failed' }

    const limitsRes = await withTimeout(app.request('account/rateLimits/read', {}), API_TIMEOUT_MS)
    const limits = limitsRes?.rateLimitsByLimitId?.codex ?? limitsRes?.rateLimits
    if (!limits) return { state: 'network', reason: 'empty rate limit response' }
    return {
      state: 'ok',
      subscriptionType: account.planType ?? limits.planType ?? 'chatgpt',
      ...classifyWindows(limits),
      fetchedAt: Date.now(),
    }
  } catch (e: any) {
    log(`usage: codex app-server usage failed: ${e?.message ?? e}`)
    return { state: 'network', reason: e?.message ?? String(e) }
  } finally {
    await app.close()
  }
}

/** 读最近一次 usage cache,不触发 fetch。给 turn footer 用 —— codex turn
 * 中 `updateUsageFromRateLimits` 已把当轮 rateLimit 写进 cache,这里直接
 * 复用,避免每轮 turn 都为拿一个百分比去 spawn 一个 codex app-server
 * 子进程(readUsage 的代价)。cache 为空(turn 中没收到 rateLimit)返回 null,
 * 调用方按 no_fallbacks 省略 5h 段。 */
export function peekUsage(): UsageSnapshot | null {
  return cache
}

export async function readUsage(): Promise<UsageSnapshot> {
  if (inFlight) return inFlight

  inFlight = fetchUsage()
    .then(d => {
      inFlight = null
      if (d.state === 'network') return cache ?? d
      cache = d
      return d
    })
    .catch(e => {
      log(`usage: fetchUsage threw: ${e}`)
      inFlight = null
      return cache ?? { state: 'network', reason: String(e) }
    })
  return inFlight
}
