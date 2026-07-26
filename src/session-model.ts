import { randomUUID } from 'node:crypto'

import type { Session } from './session'
import { listTokenSources, getTokenSource, type TokenSource } from './token-source'
import { isCodexReasoningEffort } from './codex-process'
import {
  agentProviderLabel,
  isClaudeReasoningEffort,
  providerFromModel,
  type AgentProvider,
  type AgentReasoningEffort,
} from './agent-process'
import * as cards from './cards'
import * as feishu from './feishu'
import { log } from './log'
import { messageOf, withTimeout, type ModelActionResult } from './session-util'

export interface ModelPanelState {
  models: cards.ModelChoice[]
}

// ── 第1级:账号(provider)选项 —— 每个 token source 一项 ─────
function providerChoices(s: Session): cards.ProviderChoice[] {
  const cur = s.currentTokenSource()
  const curModel = s.currentModelLabel()
  return listTokenSources()
    // native 是兜底项:仅在 enabled 时露面(本机未命中 Pro provider → 作为默认通路);
    // disabled 说明本机已用 GLM,此时它没意义,不显示灰项干扰选择。
    .filter(ts => ts.enabled || ts.kind !== 'claude-native')
    .map(ts => ({
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      display: ts.display + (cur?.id === ts.id && curModel ? ` · ${curModel}` : ''),
      enabled: ts.enabled,
      modelCount: ts.models.length,
      selected: cur?.id === ts.id,
    }))
}

// ── 第2级:某账号下的具体模型(点 provider 后展示) ──────────
function modelChoicesFor(s: Session, ts: TokenSource): cards.ModelChoice[] {
  const curModel = s.currentModelLabel()
  const curEffort = s.currentEffortLabel()
  const isCurrent = s.currentTokenSource()?.id === ts.id
  return ts.models.map(m => {
    const selected = isCurrent && curModel === m.model
    return {
      provider: ts.agent as AgentProvider,
      sourceId: ts.id,
      model: m.model,
      displayName: m.display,
      description: ts.display,
      enabled: true,
      isDefault: false,
      selected,
      efforts: m.efforts.map(e => ({
        effort: e,
        description: '',
        isDefault: e === m.defaultEffort,
        selected: selected && curEffort === e,
      })),
    }
  })
}

/** model 命令:发第1级面板(选账号)。点账号 → onProviderSelect 发第2级(该账号模型)。 */
export async function showModelPanel(s: Session): Promise<void> {
  const panelId = randomUUID()
  const providers = providerChoices(s)
  s.modelPanels.set(panelId, { models: [] })  // 第1级;第2级 onProviderSelect 填 models
  const messageId = await feishu.sendCard(s.chatId, cards.providerSelectionCard({
    sessionName: s.sessionName,
    panelId,
    currentDisplay: s.currentTokenSource()?.display ?? s.currentModelLabel(),
    providers,
  }))
  if (!messageId) {
    s.modelPanels.delete(panelId)
    await feishu.sendTextRaw(s.chatId, '❌ 模型面板发送失败')
  }
}

/** 第1级点账号 → 发第2级(该账号的模型列表)。返回第2级卡替换当前卡。 */
export async function onProviderSelect(
  s: Session,
  sourceIdRaw: string,
  panelIdRaw = '',
): Promise<ModelActionResult> {
  const sourceId = sourceIdRaw.trim()
  const ts = getTokenSource(sourceId)
  if (!ts) return { ok: false, message: `未知账号: ${sourceId}` }
  if (!ts.enabled) return { ok: false, message: `${ts.display} 未配置,请先点「启用」` }
  const panelId = panelIdRaw.trim()
  const models = modelChoicesFor(s, ts)
  s.modelPanels.set(panelId, { models })
  return {
    ok: true,
    message: '',
    card: cards.modelSelectionCard({
      sessionName: s.sessionName,
      panelId,
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      models,
    }),
  }
}

function actionProvider(model: string, raw: any): AgentProvider {
  return raw?.provider === 'claude' || raw?.provider === 'codex'
    ? raw.provider
    : providerFromModel(model)
}

function modelSelectionScope(s: Session, provider: AgentProvider): string {
  if (s.currentTurn) return '当前 turn 不变,后续新 turn 使用。'
  if (s.proc?.isAlive() && s.proc.provider === provider) {
    // codex 热切换 setModelSettings no-op(thread/settings/update 踩坑避),需重启进程生效;
    // claude 冷热都靠 env slots + SDK model,下一轮即生效。
    return provider === 'codex' ? 'Codex 需重启进程生效(发 restart)。' : '下一轮开始使用。'
  }
  return `下次启动 ${agentProviderLabel(provider)} 时使用。`
}

/** 第2级点模型 → 第3级 effort 列表。 */
export async function onModelSelect(
  s: Session,
  modelRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  actionValue: any = null,
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  if (!model) {
    const message = '模型为空'
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
  const provider = actionProvider(model, actionValue)
  const choice = s.modelPanels.get(panelIdRaw.trim())?.models
    .find(m => m.model === model && (m.provider ?? 'codex') === provider)
  if (!choice) {
    return { ok: false, message: '模型不在当前选项中,请重新发送 model' }
  }
  if (choice.enabled === false) {
    return { ok: false, message: `${choice.displayName} 未配置,请先点「启用」` }
  }
  if (choice.efforts.length === 0) return { ok: false, message: '模型未返回 effort' }
  return {
    ok: true,
    message: '',
    card: cards.modelEffortSelectionCard({
      sessionName: s.sessionName,
      panelId: panelIdRaw.trim(),
      currentModel: s.currentModelLabel(),
      currentEffort: s.currentEffortLabel(),
      model: choice,
    }),
  }
}

export async function onModelEffortSelect(
  s: Session,
  modelRaw: string,
  effortRaw: string,
  panelIdRaw = '',
  _userOpenId = '',
  providerRaw = '',
): Promise<ModelActionResult> {
  const model = modelRaw.trim()
  const effortValue = effortRaw.trim()
  if (!model) return { ok: false, message: '模型为空' }
  const panelId = panelIdRaw.trim()
  const panel = s.modelPanels.get(panelId)
  const provider: AgentProvider = providerRaw === 'claude' || providerRaw === 'codex'
    ? providerRaw
    : panel?.models.find(m => m.model === model)?.provider ?? providerFromModel(model)
  if (provider === 'claude') {
    if (!isClaudeReasoningEffort(effortValue)) return { ok: false, message: 'Claude reasoning effort 无效' }
  } else if (!isCodexReasoningEffort(effortValue)) {
    return { ok: false, message: 'Codex reasoning effort 无效' }
  }
  const effort = effortValue as AgentReasoningEffort
  const choice = panel?.models.find(m => m.model === model && (m.provider ?? 'codex') === provider)
  if (!choice || !choice.efforts.some(item => item.effort === effort)) {
    return { ok: false, message: `${agentProviderLabel(provider)} · ${model}/${effort} 不在选项中` }
  }
  const sourceChanged = !!choice.sourceId && s.currentTokenSource()?.id !== choice.sourceId
  const selectionUnchanged = s.currentProvider() === provider &&
    !sourceChanged &&
    s.currentModelLabel() === model &&
    s.currentEffortLabel() === effort
  if (selectionUnchanged) {
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `当前已是 ${agentProviderLabel(provider)} · ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
        provider,
        model,
        effort,
        scope: '当前已是此设置，无需变更。',
      }),
    }
  }
  if (
    s.proc?.isAlive() &&
    s.proc.provider !== provider &&
    (s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  ) {
    return {
      ok: false,
      message: `当前 ${s.backendLabel(s.proc.provider)} turn 正在执行或排队；请等结束或 stop 后再切换到 ${agentProviderLabel(provider)}`,
    }
  }
  const modelChanged = s.currentModelLabel() !== model
  const profileChanged = modelChanged || sourceChanged
  const procBusy = !!(s.currentTurn || s.openingTurn || s.pendingUserMessageCount > 0 || s.pendingMidTurnMsgs.length > 0)
  if (
    provider === 'claude' &&
    s.proc?.isAlive() &&
    s.proc.provider === 'claude' &&
    profileChanged &&
    procBusy
  ) {
    return {
      ok: false,
      message: '当前 Claude turn 正在执行或排队；Claude 模型 profile 通过 env 生效，请等结束或 stop 后再切换',
    }
  }
  try {
    // 不重启 agent(保持之前体验):同 provider 切 model/effort 一律 setModelSettings 热切换
    // (SDK 记新 model,下轮/下次生效)。不再 stopIdle respawn —— 那基于旧 env-alias 假设,
    // 且会静默打断用户(发 model 选个模型就把 claude 进程杀了,离谱)。
    if (s.proc?.isAlive() && s.proc.provider === provider) {
      const processModel = choice.sourceId
        ? getTokenSource(choice.sourceId)?.resolveSpawnModel(model) ?? model
        : model
      await withTimeout(s.proc.setModelSettings(processModel, effort), 20_000, 'thread/settings/update')
    }
    await s.applyModelSelection(provider, model, effort, choice.sourceId)
    const scope = modelSelectionScope(s, provider)
    s.modelPanels.delete(panelId)
    return {
      ok: true,
      message: `已选择 ${agentProviderLabel(provider)} · ${model} / ${effort}`,
      card: cards.modelResultCard({
        sessionName: s.sessionName,
        provider,
        model,
        effort,
        scope,
      }),
    }
  } catch (e) {
    const message = `模型切换失败: ${messageOf(e)}`
    log(`session "${s.sessionName}": set model settings failed: ${messageOf(e)}`)
    await feishu.sendText(s.chatId, `❌ ${message}`)
    return { ok: false, message }
  }
}
