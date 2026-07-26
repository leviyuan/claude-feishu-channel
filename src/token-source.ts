/**
 * Token Source 抽象层 —— agent 的额度/凭据来源管理。
 *
 * 三层架构:
 *   飞书层(model 面板 = 唯一入口) ─┐
 *                                   ├→ TokenSource 层(本文件,真相源)
 *   Agent 进程层(codex/claude)     ┘    ↓ spawnEnv / resolveSpawnModel / readUsage
 *
 * 声明式 provider:每个 token source 是一个自包含模块(token-source-<name>.ts),
 * 加载时 registerTokenSourceFactory(...) 登记。buildTokenSourcesFromConfig 遍历
 * factory registry 构建 —— 加新 source = 新建一个模块文件 + builtins import,
 * 不改本文件的枚举、不改 sources 数组。
 */

import type { AgentReasoningEffort } from './agent-process'
import type { TokenSourceConfig } from './config'

export type TokenSourceAgent = 'claude' | 'codex'

/** 已知 kinds(文档用;TokenSource.kind 是 string,加新 source 不必扩这里)。 */
export type TokenSourceKind = 'codex-subscription' | 'glm-coding-plan' | 'claude-native'

export interface TokenSourceCapabilities {
  /** 支持 resumeSessionAt / fork(claude=true, codex=false —— codex 无此能力) */
  resumeSessionAt: boolean
  fork: boolean
  /** host-ask marker(codex=true 走 askusr;claude 走 SDK AskUserQuestion) */
  hostAsk: boolean
}

/** 该账号下可选的具体模型(codex 订阅 7 个、glm 账号 8 个) */
export interface TokenSourceModel {
  model: string
  display: string
  efforts: AgentReasoningEffort[]
  defaultEffort: AgentReasoningEffort
}

// ── 统一用量(codex 5h/weekly、glm 5h/monthly 归一) ────────────────────

export interface UsageWindowUnified {
  kind: string
  label: string
  percent: number | null
  resetsAt: Date | null
  used?: number
  total?: number
}

export type UsageStateUnified =
  | 'ok'
  | 'no_credentials'
  | 'not_applicable'   // 该 source 无额度查询
  | 'rate_limited'
  | 'network'

export interface UsageSnapshotUnified {
  state: UsageStateUnified
  planLabel?: string
  windows: UsageWindowUnified[]
  reason?: string
  fetchedAt?: number
}

// ── env helper(各 source 共享:scrub 残留凭据防 A 账号夹带 B 的 key) ─────
type Env = Record<string, string | undefined>

const ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

export function scrubAnthropicEnv(base: Env): Env {
  const out: Env = { ...base }
  for (const k of ANTHROPIC_ENV_KEYS) delete out[k]
  return out
}

// ── TokenSource 接口 ─────────────────────────────────────

export interface TokenSource {
  id: string
  /** 固定种类(声明式:string —— 加 source 不扩枚举) */
  kind: string
  /** 绑定哪个 agent 进程(协议强制:claude 走 Anthropic,codex 走 OpenAI/app-server) */
  agent: TokenSourceAgent
  display: string
  capabilities: TokenSourceCapabilities
  /** 配没配凭据(面板据此决定可选 vs 灰显「启用」)。廉价同步信号:
   *  codex 看 ~/.codex 登录态;glm 看 config 有没有 token。精确有效性在 spawn/查额度时暴露。 */
  enabled: boolean
  models: TokenSourceModel[]
  defaultModel: string
  /** 启动/刷新时拉模型填 models。失败如实留空(MISS),绝不假数据。 */
  refreshModels(): Promise<void>
  spawnEnv(base: Env): Env
  resolveSpawnModel(model: string): string | undefined
  readUsage(): Promise<UsageSnapshotUnified>
}

// ── provider factory registry(声明式:每 source 模块加载时登记) ──────────

export interface TokenSourceFactoryDef {
  kind: string
  /** config.toml 里该 source 的 section id(如 'glm');undefined = 无 config(codex 走本地 login) */
  configSectionId?: string
  build: (cfg: TokenSourceConfig) => TokenSource
}

const factoryRegistry = new Map<string, TokenSourceFactoryDef>()

/** 每个 source 模块加载时调:声明式登记。加新 source = 新建模块 + builtins import。 */
export function registerTokenSourceFactory(def: TokenSourceFactoryDef): void {
  factoryRegistry.set(def.kind, def)
}

export function tokenSourceFactories(): TokenSourceFactoryDef[] {
  return [...factoryRegistry.values()]
}

// ── instance registry(daemon 运行时:已构建的 source 实例) ──────────────

const registry = new Map<string, TokenSource>()
let defaultId: string | null = null

export function registerTokenSource(s: TokenSource, opts?: { default?: boolean }): void {
  registry.set(s.id, s)
  if (opts?.default || defaultId === null) defaultId = s.id
}

export function getTokenSource(id: string | null | undefined): TokenSource | undefined {
  return id ? registry.get(id) : undefined
}

export function listTokenSources(): TokenSource[] {
  return [...registry.values()]
}

export function listTokenSourcesByAgent(agent: TokenSourceAgent): TokenSource[] {
  return listTokenSources().filter(s => s.agent === agent)
}

/** 某 agent 下所有「已启用」的 source(spawn / 默认选择 / 额度查询只认 enabled,
 *  disabled 的不参与 —— 避免未配置的 source 把空凭据注入子进程)。 */
export function listEnabledTokenSourcesByAgent(agent: TokenSourceAgent): TokenSource[] {
  return listTokenSourcesByAgent(agent).filter(s => s.enabled)
}

export function defaultTokenSourceId(): string | null {
  return defaultId
}

export function setDefaultTokenSource(id: string): void {
  if (registry.has(id)) defaultId = id
}

/** 仅供测试重置全局 registry,保证用例隔离。 */
export function resetTokenSourceRegistry(): void {
  registry.clear()
  defaultId = null
}
