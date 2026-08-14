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

/** regex 特殊字符转义(用于 id 拼 regex,removeTokenSource 用) */
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
 * 已存在则与新 cfg 字段级合并(新值优先,旧键保留)—— 重跑 <source>-setup
 * 只更新凭据,不洗掉 models/slots/usage 等既有配置。写完热更新 registry。 */
export function addTokenSource(id: string, cfg: TokenSourceConfig): void {
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  // 逐行状态机找节:节边界 = 行首 [xxx](值里可含 '[',如 slots = "opus=GLM-5.2[1m]",
  // regex 硬截断会吞值,故不用正则切多行节体)。
  const header = `[token_source.${id}]`
  const lines = existing.split('\n')
  let inSection = false
  const prev: Record<string, string> = {}
  const kept: string[] = []
  for (const line of lines) {
    if (line.startsWith('[')) inSection = line === header
    if (inSection) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/)
      if (m) prev[m[1]] = m[2]
    } else {
      kept.push(line)
    }
  }
  // 字段级合并:旧键打底,新 cfg 非空值覆盖(重跑 setup 只换凭据,不洗 models/slots/usage)。
  const combined: Record<string, string | undefined> = { ...prev }
  const incoming: Record<string, string | undefined> = { ...cfg }
  for (const k of Object.keys(incoming)) if (incoming[k]) combined[k] = incoming[k]
  const merged = combined as TokenSourceConfig
  // 去掉 kept 尾部空行再拼新节,保持节间一个空行的布局。
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  writeFileSync(CONFIG_FILE, kept.join('\n') + '\n\n' + cfgToToml(id, merged) + '\n')
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
