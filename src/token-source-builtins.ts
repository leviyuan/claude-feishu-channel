/**
 * 从 config 构建 token source(遍历 factory registry,声明式)。
 *
 * 每个 source 是自包含模块(token-source-<name>.ts),import 它 = 触发
 * registerTokenSourceFactory 登记。加新 source = 新建一个模块文件 +
 * 下面 import 一行,不改本文件、不改枚举、不改 sources 数组。
 */

import { config } from './config'
import {
  registerTokenSource,
  resetTokenSourceRegistry,
  setDefaultTokenSource,
  tokenSourceFactories,
} from './token-source'
import { readClaudeSettingsEnv } from './glm-usage'

// provider 模块 —— import 即登记到 factory registry(副作用)。
import './token-source-codex'
import './token-source-glm'
import './token-source-native'
import './token-source-deepseek'

/** 遍历已登记 factory 构建 source 实例,注册到 instance registry。
 *  daemon 启动调;飞书改 token source 配置后也可重调(热更新)。 */
export function buildTokenSourcesFromConfig(): number {
  resetTokenSourceRegistry()
  const settingsEnv = readClaudeSettingsEnv()
  const sources = tokenSourceFactories().map(def => {
    const cfg = def.configSectionId ? (config.token_sources[def.configSectionId] ?? {}) : {}
    // config.toml 没配时,若本机 settings.json 命中本 source 的 detect host,自动启用(凭据从 settings.json 取)
    const detected = def.detect?.fromSettingsEnv(settingsEnv) ?? null
    return def.build(cfg, detected)
  })
  // native 兜底:有显式 claude-side source(glm/deepseek/...)启用则让位;否则 native 启用(真 Claude)。
  const native = sources.find(s => s.kind === 'claude-native')
  if (native) {
    const hasClaudeSource = sources.some(s => s.agent === 'claude' && s.enabled && s.kind !== 'claude-native')
    native.enabled = !hasClaudeSource
  }
  for (const s of sources) registerTokenSource(s)
  const firstEnabled = sources.find(s => s.enabled)
  if (firstEnabled) setDefaultTokenSource(firstEnabled.id)
  return sources.length
}
