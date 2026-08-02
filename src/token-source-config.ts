/**
 * Token source 配置写入 —— 飞书 config 命令的持久化层。
 *
 * daemon 进程直接读写 ~/.config/lodestar/config.toml 的 [token_source.*] 节,
 * 改完 reloadTokenSources() + buildTokenSourcesFromConfig() 热更新 registry
 * (不重启 daemon)。让用户飞书里增删 token source,不依赖 SSH 改 config.toml。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { CONFIG_FILE } from './paths'
import { reloadTokenSources, type TokenSourceConfig } from './config'
import { buildTokenSourcesFromConfig } from './token-source-builtins'
import { refreshAllTokenSourceModels } from './token-source'

/** TOML 基本字符串转义(与 setup.ts escapeTomlString / config.ts parseToml 反转义对称) */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** regex 特殊字符转义(用于 id 拼 regex) */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cfgToToml(id: string, cfg: TokenSourceConfig): string {
  const lines = [`[token_source.${id}]`]
  const push = (k: string, v?: string) => { if (v && v.length) lines.push(`${k} = "${esc(v)}"`) }
  push('agent', cfg.agent)
  push('display', cfg.display)
  push('auth', cfg.auth)
  push('base_url', cfg.base_url)
  push('auth_token', cfg.auth_token)
  push('api_key', cfg.api_key)
  push('bin', cfg.bin)
  push('model', cfg.model)
  push('effort', cfg.effort)
  push('models', cfg.models)
  push('slots', cfg.slots)
  push('usage', cfg.usage)
  if (cfg.default) lines.push('default = "true"')
  return lines.join('\n')
}

/** 写后热更新:reload config 单例 + rebuild token source registry + 全量刷新 models。
 *  rebuild(resetTokenSourceRegistry)丢弃旧实例重建空实例,必须重新 refresh,否则非当前
 *  操作的 source models 永远空(setup deepseek 后 glm/codex 变空)。在此统一兜底,
 *  addTokenSource/removeTokenSource 的调用方不必各自记得 refresh。 */
function reloadAndRebuild(): void {
  reloadTokenSources()
  buildTokenSourcesFromConfig()
  void refreshAllTokenSourceModels()
}

/** 新增/覆盖一个 token source:追加 [token_source.<id>] 节到 config.toml。
 * 已存在则先删再写(覆盖)。写完热更新 registry。 */
export function addTokenSource(id: string, cfg: TokenSourceConfig): void {
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  let next = existing
  // 已存在则先删(覆盖语义)
  if (existing.includes(`[token_source.${id}]`)) {
    const re = new RegExp(`\\n?\\[token_source\\.${escapeRegex(id)}\\][^\\[]*`, 'g')
    next = existing.replace(re, '')
  }
  const sep = next.endsWith('\n') ? '' : '\n'
  writeFileSync(CONFIG_FILE, next + sep + '\n' + cfgToToml(id, cfg) + '\n')
  reloadAndRebuild()
}

/** 删除一个 token source:从 config.toml 移除 [token_source.<id>] 节。返回是否真删了。 */
export function removeTokenSource(id: string): boolean {
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  const re = new RegExp(`\\n?\\[token_source\\.${escapeRegex(id)}\\][^\\[]*`, 'g')
  const next = existing.replace(re, '').replace(/\n{3,}/g, '\n\n')
  if (next === existing) return false
  writeFileSync(CONFIG_FILE, next)
  reloadAndRebuild()
  return true
}
