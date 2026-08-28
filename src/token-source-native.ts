/**
 * Claude 兜底 token source —— 无显式 claude-side source(glm/deepseek/...)启用时的"裸跑"通路。
 *
 * buildTokenSourcesFromConfig 后处理:有任何 claude-side source 显式启用 → 本 source 让位(disabled);
 * 都没启用(本机配的是真 Anthropic / 订阅 login / 未识别中转)→ 本 source enabled,代表
 * 「直接用本机 Claude Code 配置裸跑」。用户在面板看到的是「Claude」(真后端),不是抽象的 native。
 *
 * 设计要点(no_fallbacks):
 *   spawnEnv       零注入、零 scrub —— 透传 base,Claude SDK 自己读 settings.json / 默认。
 *   settingSources 含 'user' —— 透传型需读本机 settings.json(env/API key/中转);
 *                  注入 env 的 source(glm/deepseek)不读 user,spawnEnv 权威。
 *   models         SDK alias 四档(fable/opus/sonnet/haiku),具体解析交给本机 ANTHROPIC_DEFAULT_*_MODEL。
 *   readUsage      无法判定后端 provider → not_applicable(显示 —),绝不假数据。
 *
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type TokenSourceModel,
  type UsageSnapshotUnified,
  registerTokenSourceFactory,
} from './token-source'
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
    // native 是兜底:无显式 claude-side source 启用时,buildTokenSourcesFromConfig 置 enabled=true。
    // 代表"裸跑本机 Claude Code 配置"(真 Anthropic / 订阅 login),不注入凭据。
    const ts: TokenSource = {
      id: 'claude-native',
      kind: 'claude-native',
      agent: 'claude',
      display: 'Claude',
      enabled: false,  // buildTokenSourcesFromConfig 后处理:无 claude source 启用时置 true
      models: NATIVE_MODELS,
      modelCatalogState: { status: 'ready', updatedAt: Date.now() },
      defaultModel: 'opus',
      // native 透传本机配置,需读 user settings.json(Claude Code 的 env / API key / 中转);
      // 注入 env 的 source(glm/deepseek)不设此字段 → DEFAULT(['project','local'],不读 user,spawnEnv 权威)。
      settingSources: ['user', 'project', 'local'],
      async refreshModels(): Promise<void> {
        // 静态 alias 列表,无网络拉取;幂等重赋值即可。
        ts.models = NATIVE_MODELS
        ts.modelCatalogState = {
          status: ts.enabled ? 'ready' : 'disabled',
          updatedAt: Date.now(),
        }
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
