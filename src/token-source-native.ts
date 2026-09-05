/**
 * 沿用本机 Claude 环境和 user settings 的账号来源。
 * 有其他已启用的 Claude 侧来源时禁用；模型使用 SDK aliases，额度不适用。
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
  // enabled 由 buildTokenSourcesFromConfig 根据其他 Claude 侧来源决定。
  build: (_cfg: TokenSourceConfig): TokenSource => {
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
        // 本机配置不提供可统一查询的额度来源。
        return { state: 'not_applicable', windows: [] }
      },
    }
    return ts
  },
})
