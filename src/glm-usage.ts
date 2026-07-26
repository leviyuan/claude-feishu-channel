/**
 * GLM Coding Plan 用量快照 —— 给 `hi` console 面板的 claude/GLM 后端用。
 *
 * 数据源是 GLM 官方 `glm-plan-usage` 插件背后同一条 monitor API(逆向自
 * zai-org/zai-coding-plugins 的 query-usage.mjs),daemon 直接打,不走
 * plugin/agent/skill 那套(那是 Claude Code CLI 用的):
 *
 *   GET {baseDomain}/api/monitor/usage/quota/limit
 *
 * 鉴权用 Claude Code 自己的两个标准环境变量 —— 它们不在 daemon 进程 env 里
 * (systemd 起的 daemon 不继承),而是写在 `~/.claude/settings.json` 的 env
 * 段、由 Claude CLI 启动子进程时注入。所以这里自己读文件拿:
 *   ANTHROPIC_AUTH_TOKEN → 裸 token,直接作 Authorization header(不带 Bearer)
 *   ANTHROPIC_BASE_URL   → 判定平台 host(open.bigmodel.cn=ZHIPU / api.z.ai=ZAI)
 *
 * 失败可见 (no_fallbacks):无凭据 / 非 GLM 后端 / 限流 / 网络各自显式标 MISS,
 * 绝不假数据。与 src/usage.ts(Codex 侧)的 snapshot 模式对齐。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log'

const API_TIMEOUT_MS = 10_000

export interface GlmUsageWindow {
  /** 0–100 已用百分比;未知为 null(MISS) */
  percent: number | null
  /** 下次重置;未知为 null */
  resetsAt: Date | null
}

export interface GlmMonthlyWindow extends GlmUsageWindow {
  /** 已用绝对值(调用次数);TIME_LIMIT 才有 */
  used?: number
  /** 周期总额度;TIME_LIMIT 才有 */
  total?: number
}

export type GlmUsageSnapshot =
  | { state: 'no_credentials' }
  | { state: 'not_glm'; baseUrl?: string }
  | { state: 'rate_limited' }
  | { state: 'network'; reason?: string }
  | {
      state: 'ok'
      /** 套餐档位(open.bigmodel.cn 的 level 字段:max / standard / …) */
      level?: string
      /** 5 小时 token 滚动窗口(TOKENS_LIMIT) */
      fiveHour: GlmUsageWindow | null
      /** 月度工具/MCP 用量(TIME_LIMIT) */
      monthly: GlmMonthlyWindow | null
      fetchedAt: number
    }

type GlmUsageSnapshotOk = Extract<GlmUsageSnapshot, { state: 'ok' }>

let cache: GlmUsageSnapshot | null = null
let inFlight: Promise<GlmUsageSnapshot> | null = null

/** Claude Code settings 目录:优先 CLAUDE_CONFIG_DIR,否则 ~/.claude。 */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * 读 ~/.claude/settings.json 的 env 段。daemon 进程默认 env 里没有
 * ANTHROPIC_* —— 那是 Claude CLI 注入给子进程的;这里从文件读才是真相源。
 * 读不到(文件缺失/解析失败)返回空 record,调用方按 no_credentials 处理。
 */
export function readClaudeSettingsEnv(): Record<string, string> {
  try {
    const raw = readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8')
    const env = JSON.parse(raw)?.env
    return env && typeof env === 'object' ? env as Record<string, string> : {}
  } catch (e) {
    log(`glm-usage: read settings.json env failed: ${e}`)
    return {}
  }
}

/** 判定一个 base_url 是否指向 GLM 官方平台 —— 启用判定(resolveClaudeGlm)与额度
 *  查询(glmDomain)共用同一套 host 判定,避免「启用说是 GLM、额度说不是」的认知割裂。
 *  只有官方端点(open./dev.bigmodel.cn、api.z.ai)才算 Pro provider 走 GLM source 的
 *  特殊 slot 注入;挂在 bigmodel.cn 下的第三方中转走 native 透传(用户配啥用啥)。 */
export function isGlmBaseUrl(baseUrl: string): boolean {
  // 严格 hostname 比较(非子串):解析 URL 取 hostname —— 避免 `open.bigmodel.cn.evil.example`
  // 或 URL 查询参数里含该文本被误判;hostname 大小写归一化。解析失败(无协议等)→ false。
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'open.bigmodel.cn' || host === 'dev.bigmodel.cn' || host === 'api.z.ai'
  } catch {
    return false
  }
}

/**
 * 解析「Claude 侧 GLM source 是否启用」的统一真相源 —— GLM source 与 native
 * 兜底 source 都调它,保证两者严格互斥(claude 侧永远恰好一个 enabled),不会
 * 因判定逻辑漂移出现两个都 enabled / 都 disabled。
 *
 * 凭据来源优先级:config.toml [token_source.glm] > ~/.claude/settings.json env
 * (且 env 的 base_url 必须命中 GLM host 才被借作 fallback —— 真 Anthropic 等非
 * GLM provider 不会被误吞)。enabled = baseUrl 与 token 都齐全。
 */
export interface ResolvedClaudeGlm {
  baseUrl: string
  token: string
  enabled: boolean
}
export function resolveClaudeGlm(cfg?: { base_url?: string; auth_token?: string }): ResolvedClaudeGlm {
  const se = readClaudeSettingsEnv()
  const envBaseUrl = se.ANTHROPIC_BASE_URL?.trim() ?? ''
  const envToken = se.ANTHROPIC_AUTH_TOKEN?.trim() ?? ''
  const envIsGlm = isGlmBaseUrl(envBaseUrl)
  const baseUrl = cfg?.base_url?.trim() || (envIsGlm ? envBaseUrl : '')
  const token = cfg?.auth_token?.trim() || (envIsGlm ? envToken : '')
  // enabled 要求 baseUrl+token 齐全,且 baseUrl 必须是 GLM 官方端点 —— 否则 config 误填的非
  // GLM 地址(真 Anthropic / 中转)会被当 GLM 启用:轻则注入错误 GLM slot/模型,重则字段
  // fallback 把 config 的 base_url 与 settings.json 的 token 拼成不匹配的凭据。非 GLM config 走 native 透传。
  return { baseUrl, token, enabled: !!(baseUrl && token) && isGlmBaseUrl(baseUrl) }
}

/** 从 ANTHROPIC_BASE_URL 取 protocol//host;非法返回 null。 */
function baseDomain(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** 判定是否 GLM 平台 host,返回 domain 或 null(非 GLM)。与 isGlmBaseUrl 共用判定。 */
function glmDomain(baseUrl: string): string | null {
  const domain = baseDomain(baseUrl)
  return domain && isGlmBaseUrl(baseUrl) ? domain : null
}

function clampPct(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function resetDate(ms: unknown): Date | null {
  return typeof ms === 'number' && isFinite(ms) && ms > 0 ? new Date(ms) : null
}

/** 解析 quota/limit 响应 → ok 快照;limits 缺字段按 null(MISS)渲染。 */
function parseQuotaLimit(data: any): GlmUsageSnapshotOk {
  const limits: any[] = Array.isArray(data?.limits) ? data.limits : []
  const tokens = limits.find(l => l?.type === 'TOKENS_LIMIT')
  const time = limits.find(l => l?.type === 'TIME_LIMIT')
  const fiveHour: GlmUsageWindow | null = tokens
    ? { percent: clampPct(tokens.percentage), resetsAt: resetDate(tokens.nextResetTime) }
    : null
  const monthly: GlmMonthlyWindow | null = time
    ? {
        percent: clampPct(time.percentage),
        resetsAt: resetDate(time.nextResetTime),
        ...(typeof time.currentValue === 'number' ? { used: time.currentValue } : {}),
        ...(typeof time.usage === 'number' ? { total: time.usage } : {}),
      }
    : null
  return {
    state: 'ok',
    level: typeof data?.level === 'string' && data.level ? data.level : undefined,
    fiveHour,
    monthly,
    fetchedAt: Date.now(),
  }
}

export async function fetchGlmUsage(baseUrlOverride?: string, tokenOverride?: string): Promise<GlmUsageSnapshot> {
  const env = (baseUrlOverride && tokenOverride)
    ? { ANTHROPIC_BASE_URL: baseUrlOverride, ANTHROPIC_AUTH_TOKEN: tokenOverride }
    : readClaudeSettingsEnv()
  const token = env.ANTHROPIC_AUTH_TOKEN
  const baseUrl = env.ANTHROPIC_BASE_URL || ''
  if (!token) return { state: 'no_credentials' }

  const domain = glmDomain(baseUrl)
  if (!domain) return { state: 'not_glm', baseUrl: baseUrl || undefined }

  const url = `${domain}/api/monitor/usage/quota/limit`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      signal: controller.signal,
    })
    if (res.status === 429) return { state: 'rate_limited' }
    if (!res.ok) return { state: 'network', reason: `HTTP ${res.status}` }
    const json = await res.json()
    if (json?.success === false || (typeof json?.code === 'number' && json.code !== 200)) {
      return { state: 'network', reason: json?.msg ? String(json.msg) : `code ${json?.code}` }
    }
    const data = json?.data ?? json
    return parseQuotaLimit(data)
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? `timeout ${API_TIMEOUT_MS}ms` : (e?.message ?? String(e))
    log(`glm-usage: quota/limit fetch failed: ${reason}`)
    return { state: 'network', reason }
  } finally {
    clearTimeout(timer)
  }
}

export async function readGlmUsage(): Promise<GlmUsageSnapshot> {
  if (inFlight) return inFlight
  inFlight = fetchGlmUsage()
    .then(d => {
      inFlight = null
      // 网络态保留上次成功的 cache(若有),否则如实返回失败态 ——
      // 与 usage.ts 一致:绝不假数据。
      if (d.state === 'network') return cache ?? d
      cache = d
      return d
    })
    .catch(e => {
      log(`glm-usage: fetchGlmUsage threw: ${e}`)
      inFlight = null
      return cache ?? { state: 'network', reason: String(e) }
    })
  return inFlight
}
