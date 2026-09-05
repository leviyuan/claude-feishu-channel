/** 群内账号启用和模型补录的配置写入；重建账号目录并等待模型刷新。 */

import { readFileSync } from 'node:fs'
import { CONFIG_FILE } from './paths'
import { reloadTokenSources, type TokenSourceConfig } from './config'
import { buildTokenSourcesFromConfig } from './token-source-builtins'
import { refreshAllTokenSourceModels } from './token-source'
import { writeStateFileAtomic } from './state-store'

/** TOML 基本字符串转义(与 setup.ts escapeTomlString / config.ts parseToml 反转义对称) */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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

/** 新增/覆盖一个 token source:追加 [token_source.<id>] 节到 config.toml。
 * 已存在则与新 cfg 字段级合并(新值优先,旧键保留)—— 重跑 <source>-setup
 * 只更新凭据,不洗掉 models/slots/usage 等既有配置。写完热更新 registry。 */
export async function addTokenSource(id: string, cfg: TokenSourceConfig): Promise<void> {
  const existing = readFileSync(CONFIG_FILE, 'utf8')
  // 逐行状态机找节:节边界 = 行首 [xxx](值里可含 '[',如 slots = "opus=GLM-5.2[1m]",
  // regex 硬截断会吞值,故不用正则切多行节体)。
  const header = `[token_source.${id}]`
  const lines = existing.split('\n')
  let inSection = false
  const prev: Record<string, string> = {}
  const kept: string[] = []
  for (const line of lines) {
    const section = line.match(/^\s*(\[[^\]]+\])\s*(?:#.*)?$/)?.[1]
    if (section) inSection = section === header
    if (inSection) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/)
      if (m) prev[m[1]] = m[2]
    } else {
      kept.push(line)
    }
  }
  // 字段级合并:旧键打底,新 cfg 非空值覆盖(重跑 setup 只换凭据,不洗 models/slots/usage)。
  type ConfigScalar = string | boolean | undefined
  const combined: Record<string, ConfigScalar> = { ...prev }
  const incoming: Record<string, ConfigScalar> = { ...cfg }
  for (const k of Object.keys(incoming)) if (incoming[k]) combined[k] = incoming[k]
  const merged = combined as TokenSourceConfig
  // 去掉 kept 尾部空行再拼新节,保持节间一个空行的布局。
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  writeStateFileAtomic(CONFIG_FILE, kept.join('\n') + '\n\n' + cfgToToml(id, merged) + '\n')
  reloadTokenSources()
  buildTokenSourcesFromConfig()
  // 重建会清空各账号的目录；所有调用方共用这次刷新。
  await refreshAllTokenSourceModels()
}
