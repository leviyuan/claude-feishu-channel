/**
 * Token source 模型列表拉取 —— 动态获取订阅真实模型,零写死。
 *
 * codex 订阅:app-server `model/list`(per-model effort、过滤 hidden)。
 * glm Coding Plan:anthropic 端点 `/v1/models`(返回 display_name + id + created_at)。
 * 失败都抛错 —— 调用方(refreshModels)按 MISS 留空 models,绝不假数据。
 */

import { AppServerOnce } from './usage'
import type { TokenSourceModel } from './token-source'
import type { AgentReasoningEffort } from './agent-process'

const TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
function codexEffort(e: unknown): AgentReasoningEffort | null {
  return typeof e === 'string' && (CODEX_EFFORTS as string[]).includes(e)
    ? e as AgentReasoningEffort
    : null
}

export const CLAUDE_EFFORTS: AgentReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low']

/** codex 订阅可用模型(app-server model/list),过滤 hidden,effort 用 per-model。 */
export async function fetchCodexModels(): Promise<TokenSourceModel[]> {
  const app = new AppServerOnce()
  try {
    await withTimeout(app.request('initialize', {
      clientInfo: { name: 'lodestar-models', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }))
    const res = await withTimeout(app.request('model/list', {}))
    const data: any[] = Array.isArray(res?.data) ? res.data : []
    const out: TokenSourceModel[] = []
    for (const m of data) {
      if (!m || m.hidden || !m.id) continue
      const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
        .map((e: any) => codexEffort(e?.reasoningEffort))
        .filter((e): e is AgentReasoningEffort => e !== null)
      if (!efforts.length) continue
      const defaultEffort = codexEffort(m.defaultReasoningEffort) ?? efforts[0]
      out.push({
        model: String(m.id),
        display: typeof m.displayName === 'string' && m.displayName ? String(m.displayName) : String(m.id),
        efforts,
        defaultEffort,
      })
    }
    return out
  } finally {
    await app.close()
  }
}

/** glm Coding Plan 可用模型(anthropic 端点 /v1/models)。用 display_name(端点接受的大写形式)。 */
export async function fetchGlmModels(baseUrl: string, token: string): Promise<TokenSourceModel[]> {
  const u = new URL(baseUrl)
  const path = u.pathname.replace(/\/+$/, '')
  const url = `${u.protocol}//${u.host}${path}/v1/models`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const data: any[] = Array.isArray(json?.data) ? json.data : []
  return data
    .filter(m => m && (m.display_name || m.id))
    .map(m => {
      const id = String(m.display_name || m.id)
      return { model: id, display: id, efforts: CLAUDE_EFFORTS, defaultEffort: 'max' as AgentReasoningEffort }
    })
}
