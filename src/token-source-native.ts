/**
 * Claude 本机兜底 token source —— 「装上即用」的默认通路。
 *
 * 与 GLM source 严格互斥(resolveClaudeGlm 为单一真相源):本机 Claude 配置
 * (~/.claude/settings.json env / lodestar config.toml [token_source.glm])命中 GLM
 * 时,GLM source 启用(带真模型列表 + 额度展示),本 source 自禁用让位;否则本
 * source 启用,代表「直接用本机 Claude Code 配置裸跑」—— 不管用户配的是真
 * Anthropic、DeepSeek、中转站还是全新裸机,lodestar 都直接可用,不报「未配置」。
 *
 * 设计要点(no_fallbacks):
 *   spawnEnv     零注入、零 scrub —— 透传 base,Claude SDK 自己读 settings.json / 默认。
 *   models       SDK alias 四档(fable/opus/sonnet/haiku),具体解析交给
 *                settings.json 的 ANTHROPIC_DEFAULT_*_MODEL,native 不假设后端。
 *   readUsage    无法判定后端 provider → not_applicable(显示 —),绝不假数据。
 *
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  registerTokenSourceFactory,
} from './token-source'
import { resolveClaudeGlm } from './glm-usage'
import { CLAUDE_EFFORTS } from './token-source-models'

type Env = Record<string, string | undefined>

// SDK alias 四档;具体模型由 settings.json 的 ANTHROPIC_DEFAULT_*_MODEL 解析。
// native 不假设后端是哪个 Claude 档位,只下发 alias。
const NATIVE_MODELS: TokenSourceModel[] = [
  { model: 'fable',  display: 'Fable',  efforts: CLAUDE_EFFORTS, defaultEffort: 'max' },
  { model: 'opus',   display: 'Opus',   efforts: CLAUDE_EFFORTS, defaultEffort: 'high' },
  { model: 'sonnet', display: 'Sonnet', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
  { model: 'haiku',  display: 'Haiku',  efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
]

registerTokenSourceFactory({
  kind: 'claude-native',
  // 无独立 config 节 —— 它的 enabled 由 GLM 判定取反决定,与 [token_source.glm] 共用真相源。
  build: (_cfg: TokenSourceConfig): TokenSource => {
    // 与 GLM source 互斥:GLM 凭据齐全(本机配的就是 GLM)→ native 让位。
    // config.token_sources.glm 与 token-source-glm.ts build 收到的同一份 cfg,判定一致。
    const glmEnabled = resolveClaudeGlm(config.token_sources.glm).enabled
    const ts: TokenSource = {
      id: 'claude-native',
      kind: 'claude-native',
      agent: 'claude',
      display: 'Claude(本机)',
      capabilities: { resumeSessionAt: true, fork: true, hostAsk: false },
      enabled: !glmEnabled,
      models: NATIVE_MODELS,
      defaultModel: 'opus',
      async refreshModels(): Promise<void> {
        // 静态 alias 列表,无网络拉取;幂等重赋值即可。
        ts.models = NATIVE_MODELS
      },
      spawnEnv(base: Env): Env {
        // 透传:零注入、零 scrub —— Claude SDK 完全用本机 settings.json / 默认配置。
        return base
      },
      resolveSpawnModel(model: string): string {
        // 透传 SDK alias(opus/sonnet/haiku/fable),由 SDK + settings.json 解析具体模型。
        return model
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        // 无法判定后端 provider,无额度查询 → 显式 MISS,绝不假数据。
        return { state: 'not_applicable', windows: [] }
      },
    }
    return ts
  },
})
