/**
 * Token source 启用交互 —— 未配置 source 的「启用」入口(model 面板是唯一配置入口)。
 *
 * - 点 model 面板「启用」按钮 → onTokenSourceEnable → 据 factory 的 setup.hint 弹引导
 *   (codex 走 login,native 无 setup —— 各自特例)。
 * - `<source>-setup <args>` 文本命令 → runTokenSourceSetup → 路由到 factory 的 setup.parseArgs
 *   → 写 config + 热更新 registry + 全量刷新 models。
 *
 * 加新 source:token-source-<name>.ts 声明 setup 字段(hint + parseArgs + commandSuffix),
 * 自动接入「启用」引导 + `<source>-setup` 命令 —— 不改本文件、不改 session-commands。
 * 不再有 config 命令/面板 —— 配置与切换统一在 model 面板。
 */

import * as feishu from './feishu'
import { getTokenSource, tokenSourceFactories, refreshAllTokenSourceModels } from './token-source'
import { addTokenSource } from './token-source-config'
import type { Session } from './session'

/** model 面板「启用」按钮回调:据 factory setup.hint 弹启用引导(codex/native 特例)。 */
export async function onTokenSourceEnable(s: Session, sourceId: string): Promise<void> {
  const ts = getTokenSource(sourceId)
  if (!ts) {
    await feishu.sendText(s.chatId, `❌ 未知 token source: ${sourceId}`)
    return
  }
  if (ts.enabled) {
    await feishu.sendText(s.chatId, `${ts.display} 已启用,发 \`model\` 选择。`)
    return
  }
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId || d.configSectionId === sourceId)
  if (def?.setup) {
    await feishu.sendText(s.chatId, def.setup.hint(ts.display))
  } else if (ts.kind === 'codex-subscription') {
    await feishu.sendText(
      s.chatId,
      `${ts.display} 需要 ChatGPT 登录:在服务器执行 \`codex login\`,完成后重启 daemon(\`systemctl --user restart feishu-daemon\`)或重发 \`model\` 刷新。`,
    )
  } else if (ts.kind === 'claude-native') {
    // native 凭本机 Claude 配置自动启用/禁用,无独立「启用」操作(它就是默认通路)。
    await feishu.sendText(s.chatId, `${ts.display} 直接使用本机 Claude Code 配置,无需单独启用。`)
  }
}

/** `<source>-setup <args>` generic:路由到 factory setup.parseArgs → 写 config + 全量刷新 models。
 *  commandSuffix 不匹配 / 无 setup → 报错(codex login / native 无此命令)。 */
export async function runTokenSourceSetup(s: Session, sourceId: string, args: string): Promise<void> {
  const def = tokenSourceFactories().find(d => d.setup?.commandSuffix === sourceId)
  if (!def?.setup || !def.configSectionId) {
    await feishu.sendText(s.chatId, `❌ 未知或不可配置的 source: ${sourceId}`)
    return
  }
  const parsed = def.setup.parseArgs(args)
  if ('error' in parsed) {
    await feishu.sendText(s.chatId, parsed.error)
    return
  }
  try {
    addTokenSource(def.configSectionId, parsed.config)
    // rebuild registry 后全量刷新 —— 否则 glm/codex 新实例 models 永远空。
    await refreshAllTokenSourceModels()
    const ts = getTokenSource(def.configSectionId)
    await feishu.sendText(s.chatId, `✅ ${ts?.display ?? sourceId} 已启用。发 \`model\` 重新选择。`)
  } catch (e: any) {
    await feishu.sendText(s.chatId, `❌ 启用失败: ${e?.message ?? e}`)
  }
}
