import { randomUUID } from 'node:crypto'
import type { Session } from './session'
import * as cards from './cards'
import * as feishu from './feishu'
import {
  CONSULT_ROLES,
  createConsultIdentityPreset,
  deleteConsultIdentityPreset,
  getConsultIdentityCatalog,
  listConsultIdentityPresets,
  toggleConsultIdentityPreset,
  type ConsultRole,
} from './consult-identities'
import type { ModelActionResult } from './session-util'

const PAGE_SIZE = 8
const PANEL_TTL_MS = 30 * 60 * 1000

interface ConsultIdentityPanelState {
  ownerOpenId: string
  page: number
  createdAt: number
}

const panels = new Map<string, ConsultIdentityPanelState>()

export async function showConsultIdentityPanel(s: Session, userOpenId: string): Promise<void> {
  if (!userOpenId.trim()) {
    await feishu.sendTextRaw(s.chatId, '❌ 无法确认操作者身份，未打开全局 reviewers 面板')
    return
  }
  prunePanels()
  const panelId = `reviewers_${randomUUID()}`
  panels.set(panelId, { ownerOpenId: userOpenId, page: 0, createdAt: Date.now() })
  const messageId = await feishu.sendCard(s.chatId, listCard(panelId))
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ reviewers 面板发送失败')
}

export function onConsultIdentityAdd(panelId: string, identityId: string, userOpenId: string): ModelActionResult {
  const panel = requirePanel(panelId, userOpenId)
  const identity = getConsultIdentityCatalog().identities.find(item => item.origin === 'catalog' && item.id === identityId)
  if (!identity) return failure(panelId, '底层模型身份已失效')
  if (identity.status !== 'ready') return failure(panelId, identity.reason ?? `身份不可用: ${identity.status}`)
  panel.createdAt = Date.now()
  return { ok: true, message: '请选择评审角色', card: cards.consultIdentityRoleCard({ panelId, identity }) }
}

export function onConsultIdentityRole(
  panelId: string,
  identityId: string,
  roleRaw: string,
  userOpenId: string,
): ModelActionResult {
  requirePanel(panelId, userOpenId)
  if (!CONSULT_ROLES.includes(roleRaw as ConsultRole)) return failure(panelId, '无效评审角色')
  try {
    const preset = createConsultIdentityPreset(identityId, roleRaw as ConsultRole, 'max')
    return success(panelId, `已创建全局身份：${preset.name}`)
  } catch (error) {
    return failure(panelId, error instanceof Error ? error.message : String(error))
  }
}

export function onConsultIdentityToggle(panelId: string, presetId: string, userOpenId: string): ModelActionResult {
  requirePanel(panelId, userOpenId)
  try {
    const preset = toggleConsultIdentityPreset(presetId)
    return success(panelId, `${preset.name}已${preset.enabled ? '启用' : '停用'}`)
  } catch (error) {
    return failure(panelId, error instanceof Error ? error.message : String(error))
  }
}

export function onConsultIdentityDelete(panelId: string, presetId: string, userOpenId: string): ModelActionResult {
  requirePanel(panelId, userOpenId)
  const preset = listConsultIdentityPresets().find(item => item.id === presetId)
  if (!preset) return failure(panelId, '全局身份已不存在')
  return { ok: true, message: '请确认删除', card: cards.consultIdentityDeleteCard({ panelId, preset }) }
}

export function onConsultIdentityDeleteConfirm(panelId: string, presetId: string, userOpenId: string): ModelActionResult {
  requirePanel(panelId, userOpenId)
  try {
    deleteConsultIdentityPreset(presetId)
    return success(panelId, '全局身份已删除')
  } catch (error) {
    return failure(panelId, error instanceof Error ? error.message : String(error))
  }
}

export function onConsultIdentityPage(panelId: string, pageRaw: unknown, userOpenId: string): ModelActionResult {
  const panel = requirePanel(panelId, userOpenId)
  const totalPages = pageCount()
  const page = Number(pageRaw)
  if (!Number.isInteger(page)) return failure(panelId, '无效页码')
  panel.page = Math.max(0, Math.min(totalPages - 1, page))
  panel.createdAt = Date.now()
  return { ok: true, message: '已更新', card: listCard(panelId) }
}

export function onConsultIdentityBack(panelId: string, userOpenId: string): ModelActionResult {
  requirePanel(panelId, userOpenId)
  return { ok: true, message: '已返回', card: listCard(panelId) }
}

function success(panelId: string, message: string): ModelActionResult {
  return {
    ok: true,
    message,
    card: listCard(panelId, { type: 'success', content: `✅ ${message}` }),
  }
}

function failure(panelId: string, message: string): ModelActionResult {
  return {
    ok: false,
    message,
    card: panels.has(panelId)
      ? listCard(panelId, { type: 'error', content: `❌ ${message}` })
      : cards.selectionResultCard({ title: 'reviewers', message, ok: false }),
  }
}

function listCard(panelId: string, notice?: cards.ConsultIdentityPanelNotice): object {
  const panel = panels.get(panelId)
  if (!panel) throw new Error('评审身份面板已过期')
  const catalog = getConsultIdentityCatalog()
  const base = catalog.identities.filter(identity => identity.origin === 'catalog')
  const presets = listConsultIdentityPresets()
  const totalPages = Math.max(1, Math.ceil(base.length / PAGE_SIZE), Math.ceil(presets.length / PAGE_SIZE))
  panel.page = Math.min(panel.page, totalPages - 1)
  const start = panel.page * PAGE_SIZE
  return cards.consultIdentityListCard({
    panelId,
    page: panel.page,
    totalPages,
    catalog: base.slice(start, start + PAGE_SIZE),
    presets: presets.slice(start, start + PAGE_SIZE),
    failures: catalog.sourceFailures,
    presetFailure: catalog.presetFailure,
    notice,
  })
}

function pageCount(): number {
  const count = getConsultIdentityCatalog().identities.filter(identity => identity.origin === 'catalog').length
  return Math.max(1, Math.ceil(count / PAGE_SIZE), Math.ceil(listConsultIdentityPresets().length / PAGE_SIZE))
}

function requirePanel(panelId: string, userOpenId: string): ConsultIdentityPanelState {
  prunePanels()
  const panel = panels.get(panelId)
  if (!panel) throw new Error('评审身份面板已过期，请重新发送 reviewers')
  if (!panel.ownerOpenId || !userOpenId || panel.ownerOpenId !== userOpenId) {
    throw new Error('只有打开该面板的用户可修改全局身份')
  }
  return panel
}

function prunePanels(): void {
  const cutoff = Date.now() - PANEL_TTL_MS
  for (const [id, panel] of panels) if (panel.createdAt < cutoff) panels.delete(id)
}
