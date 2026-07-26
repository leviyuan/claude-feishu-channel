/**
 * GLM Coding Plan token source(anthropic 兼容端点)—— 自包含 provider 模块。
 *
 * 模型 = anthropic 端点 /v1/models 动态拉(display_name;GLM-5.2 spawn 加 [1m] 给 1M);
 * 额度 = quota/limit(真);enabled = config 有 base_url+token。
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { fetchGlmUsage, resolveClaudeGlm, type GlmUsageSnapshot, type GlmUsageWindow, type GlmMonthlyWindow } from './glm-usage'
import { fetchGlmModels } from './token-source-models'
import { log } from './log'

type Env = Record<string, string | undefined>

function glmWindowToUnified(w: GlmUsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
}

function glmMonthlyToUnified(w: GlmMonthlyWindow): UsageWindowUnified {
  return {
    kind: 'monthly', label: '月度工具', percent: w.percent, resetsAt: w.resetsAt,
    ...(w.used != null ? { used: w.used } : {}),
    ...(w.total != null ? { total: w.total } : {}),
  }
}

function glmUsageToUnified(s: GlmUsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'not_glm' ? 'not_applicable'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
      ...(s.state === 'network' && s.reason ? { reason: s.reason } : {}),
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(glmWindowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.monthly) windows.push(glmMonthlyToUnified(s.monthly))
  return {
    state: 'ok',
    planLabel: s.level ? `${s.level} 套餐` : undefined,
    windows,
    fetchedAt: s.fetchedAt,
  }
}

registerTokenSourceFactory({
  kind: 'glm-coding-plan',
  configSectionId: 'glm',
  build: (cfg: TokenSourceConfig): TokenSource => {
    // GLM 启用判定走 glm-usage.ts 的 resolveClaudeGlm(与 native 兜底 source 共享,
    // 保证严格互斥)。优先级 config.toml [token_source.glm] > ~/.claude/settings.json
    // env(后者 base_url 须命中 GLM host 才被借作 fallback,真 Anthropic 等不会被吞)。
    const { baseUrl, token, enabled } = resolveClaudeGlm(cfg)
    const ts: TokenSource = {
      id: 'glm',
      kind: 'glm-coding-plan',
      agent: 'claude',
      display: 'GLM Coding Plan',
      capabilities: { resumeSessionAt: true, fork: true, hostAsk: false },
      enabled,
      models: [],
      defaultModel: 'GLM-5.2',
      async refreshModels(): Promise<void> {
        if (!ts.enabled) { ts.models = []; return }
        try {
          ts.models = await fetchGlmModels(baseUrl, token)
          const main = ts.models.find(m => m.model === 'GLM-5.2')
          if (main) ts.defaultModel = main.model
        } catch (e: any) {
          log(`glm refreshModels MISS: ${e?.message ?? e}`)
          ts.models = []
        }
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        const merged = { ...config.claude.env }
        merged.ANTHROPIC_BASE_URL = baseUrl
        merged.ANTHROPIC_AUTH_TOKEN = token
        // 默认 slots(SDK 走 alias 的 fallback);resolveSpawnModel 下发具体 model 时不读这些。
        merged.ANTHROPIC_DEFAULT_OPUS_MODEL = 'GLM-5.2[1m]'
        merged.ANTHROPIC_DEFAULT_SONNET_MODEL = 'GLM-5.2[1m]'
        merged.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'GLM-4.7'
        return { ...out, ...merged }
      },
      resolveSpawnModel(model: string): string | undefined {
        // 下发具体 model(不走 'opus' alias),选 GLM-4.7 真跑 GLM-4.7。GLM-5.2 加 [1m] 给 1M context。
        return model === 'GLM-5.2' ? 'GLM-5.2[1m]' : model
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        // 额度用本 source 的 baseUrl/token 查(不经全局 readGlmUsage 的 settings.json,避免凭据不一致)
        return glmUsageToUnified(await fetchGlmUsage(baseUrl, token))
      },
    }
    return ts
  },
})
