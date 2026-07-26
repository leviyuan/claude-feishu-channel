/**
 * Token source 启用交互 —— 未配置 source 的「启用」入口(model 面板是唯一配置入口)。
 *
 * - 点 model 面板「启用」按钮 → onTokenSourceEnable → 据 kind 弹引导:
 *     glm → 提示发 `glm-setup <base_url> <token>`;
 *     codex → 提示在服务器 `codex login`(飞书里没法交互登录)。
 * - `glm-setup` 文本命令 → runGlmSetupCommand → 写 config.toml [token_source.glm]
 *   + 热更新 registry(reloadTokenSources + buildTokenSourcesFromConfig)+ 刷新 models。
 *
 * 不再有 config 命令/面板 —— 配置与切换统一在 model 面板。
 */

import * as feishu from './feishu'
import { getTokenSource } from './token-source'
import { addTokenSource } from './token-source-config'
import type { Session } from './session'

/** model 面板「启用」按钮回调:据 kind 弹启用引导。 */
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
  if (ts.kind === 'glm-coding-plan') {
    await feishu.sendText(s.chatId, `启用 ${ts.display}:发送\n\`\`\`\nglm-setup <base_url> <token>\n\`\`\``)
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

/** `glm-setup <base_url> <token>` 文本命令:写 config + 热更新 registry + 刷新 models。 */
export async function runGlmSetupCommand(s: Session, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/)
  if (parts.length < 2) {
    await feishu.sendText(s.chatId, '用法:`glm-setup <base_url> <token>`')
    return
  }
  const [baseUrl, token] = parts
  try {
    addTokenSource('glm', { agent: 'claude', base_url: baseUrl, auth_token: token })
    const glm = getTokenSource('glm')
    if (glm) await glm.refreshModels()
    await feishu.sendText(s.chatId, `✅ ${glm?.display ?? 'GLM Coding Plan'} 已启用(base_url=${baseUrl})。发 \`model\` 重新选择。`)
  } catch (e: any) {
    await feishu.sendText(s.chatId, `❌ 启用失败: ${e?.message ?? e}`)
  }
}
