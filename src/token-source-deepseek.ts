/**
 * DeepSeek token source(anthropic 兼容端点)—— 自包含 provider 模块。
 *
 * DeepSeek 官方提供 Anthropic 兼容端点(https://api.deepseek.com/anthropic),
 * 认证用 x-api-key → SDK 读 ANTHROPIC_API_KEY(注意:与 GLM 的
 * ANTHROPIC_AUTH_TOKEN / Bearer 不同 —— DeepSeek 走裸 api-key)。
 *
 * 模型 = 静态 deepseek-v4-pro / deepseek-v4-flash(官方两个,均支持 tool calls +
 * 1M context + Anthropic API;V4 迭代慢,静态比动态拉稳,refreshModels 幂等重赋值);
 * 额度 = {host}/user/balance(剩余余额标量,非 GLM 的滚动窗口百分比);
 * enabled = config [token_source.deepseek] 有 api_key(base_url 有官方默认,故只认 key)。
 *
 * 与 GLM / native 无互斥:GLM 的 isGlmBaseUrl 只认 bigmodel/z.ai host,DeepSeek
 * 官方 host 不被吞;native 的 enabled 只看 GLM 判定取反 —— 三者靠 model 面板的
 * tokenSourceId 二选一,可并存。模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { CLAUDE_EFFORTS } from './token-source-models'
import { log } from './log'

type Env = Record<string, string | undefined>

/** DeepSeek 官方 Anthropic 兼容端点(用户可在 config 覆盖,如自建中转)。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

const DEEPSEEK_MODELS: TokenSourceModel[] = [
  { model: 'deepseek-v4-pro', display: 'DeepSeek V4 Pro', efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  { model: 'deepseek-v4-flash', display: 'DeepSeek V4 Flash', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
]

/** 判定 base_url 是否 DeepSeek 官方端点(detect 探测本机配置用)。 */
function isDeepseekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
  } catch { return false }
}

const BALANCE_TIMEOUT_MS = 10_000

/** GET {host}/user/balance(OpenAI 根路径,Bearer 认证)→ 剩余余额标量。
 *  DeepSeek 是充值余额模型(无配额百分比),故 planLabel 装余额、windows 空;
 *  失败如实 MISS(no_fallbacks),绝不假数据。 */
async function fetchDeepseekBalance(baseUrl: string, apiKey: string): Promise<UsageSnapshotUnified> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return { state: 'network', windows: [], reason: 'bad base_url' }
  }
  try {
    const res = await fetch(`${origin}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!res.ok) return { state: 'network', windows: [], reason: `HTTP ${res.status}` }
    const json: any = await res.json()
    const infos: any[] = Array.isArray(json?.balance_infos) ? json.balance_infos : []
    const info = infos[0]
    const currency = typeof info?.currency === 'string' ? info.currency : ''
    const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? `${currency} ` : ''
    const total = info?.total_balance
    if (typeof total !== 'string' && typeof total !== 'number') {
      return { state: 'ok', windows: [], planLabel: '余额 —(无明细)' }
    }
    const avail = json?.is_available !== false
    return {
      state: 'ok',
      windows: [],
      planLabel: avail ? `剩余 ${sym}${total}` : `⚠️ 余额不足 ${sym}${total}`,
    }
  } catch (e: any) {
    log(`deepseek readUsage MISS: ${e?.message ?? e}`)
    return { state: 'network', windows: [], reason: e?.message ?? String(e) }
  }
}

registerTokenSourceFactory({
  kind: 'deepseek',
  configSectionId: 'deepseek',
  build: (cfg: TokenSourceConfig, detected?: Partial<TokenSourceConfig> | null): TokenSource => {
    const baseUrl = cfg.base_url?.trim() || detected?.base_url?.trim() || DEFAULT_BASE_URL
    const apiKey = cfg.api_key?.trim() || detected?.api_key?.trim() || ''
    const enabled = !!apiKey
    const ts: TokenSource = {
      id: 'deepseek',
      kind: 'deepseek',
      agent: 'claude',
      display: 'DeepSeek',
      capabilities: { resumeSessionAt: true, fork: true, hostAsk: false },
      enabled,
      models: DEEPSEEK_MODELS,
      defaultModel: 'deepseek-v4-pro',
      async refreshModels(): Promise<void> {
        // 静态列表(V4 两档,迭代慢),幂等重赋值;不依赖网络拉取。
        ts.models = DEEPSEEK_MODELS
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        const merged = { ...config.claude.env }
        merged.ANTHROPIC_BASE_URL = baseUrl
        // DeepSeek Anthropic 端点认 x-api-key → ANTHROPIC_API_KEY(非 AUTH_TOKEN/Bearer)。
        merged.ANTHROPIC_API_KEY = apiKey
        // alias 槽位 fallback(pro=opus 档 / flash=其余档),与官方 claude-* 名字映射对齐。带 [1m] 给 1M。
        merged.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro[1m]'
        merged.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-flash[1m]'
        merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash[1m]'
        return { ...out, ...merged }
      },
      resolveSpawnModel(model: string): string | undefined {
        // 加 [1m] 后缀给 1M context(同 GLM 约定):SDK 据 [1m] 报 contextWindow=1M,否则默认 200K。
        // 端点剥后缀跑真实模型(curl 验证 response.model=deepseek-v4-pro)。已带 [1m] 不重复加。
        return model.endsWith('[1m]') ? model : `${model}[1m]`
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        if (!apiKey) return { state: 'no_credentials', windows: [] }
        return fetchDeepseekBalance(baseUrl, apiKey)
      },
    }
    return ts
  },
  setup: {
    commandSuffix: 'deepseek',
    hint: display => `启用 ${display}:发送\n\`\`\`\ndeepseek-setup <api_key>\n\`\`\`\n默认官方 Anthropic 端点;自建中转用 \`deepseek-setup <base_url> <api_key>\`。`,
    parseArgs: args => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (!parts.length) return { error: '用法:`deepseek-setup <api_key>`(官方端点)或 `deepseek-setup <base_url> <api_key>`(自建中转)' }
      const baseUrl = parts.length >= 2 ? parts[0] : undefined
      const apiKey = parts.length >= 2 ? parts[1] : parts[0]
      return { config: { agent: 'claude', ...(baseUrl ? { base_url: baseUrl } : {}), api_key: apiKey } }
    },
  },
  detect: {
    fromSettingsEnv(env) {
      const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? ''
      if (!isDeepseekBaseUrl(baseUrl)) return null
      const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? ''
      return apiKey ? { base_url: baseUrl, api_key: apiKey } : null
    },
  },
})
