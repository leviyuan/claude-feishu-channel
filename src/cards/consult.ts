import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'
import type {
  ConsultIdentity,
  ConsultIdentityPreset,
  ConsultRole,
  ConsultSourceFailure,
} from '../consult-identities'
import { roleLabel } from '../consult-roles'
import { createHash } from 'node:crypto'
import type { ConsultReviewerResult, ConsultRunSnapshot } from '../consult-types'

export interface ConsultIdentityPanelNotice {
  type: 'success' | 'error' | 'info'
  content: string
}

export interface ConsultIdentityListCardOpts {
  panelId: string
  page: number
  totalPages: number
  catalog: ConsultIdentity[]
  presets: ConsultIdentityPreset[]
  failures: ConsultSourceFailure[]
  presetFailure?: string
  notice?: ConsultIdentityPanelNotice
}

export function consultIdentityListCard(opts: ConsultIdentityListCardOpts): object {
  const elements: object[] = []
  if (opts.notice) elements.push(noticeElement(opts.notice))
  elements.push({
    tag: 'markdown',
    element_id: ELEMENTS.consultIdentityPanel,
    content: [
      '**全局评审身份**',
      '所有项目群共用。每个 Token Source 的每个模型都会自动生成 `max` 默认身份。',
      `目录第 ${opts.page + 1}/${opts.totalPages} 页`,
    ].join('\n'),
  })
  if (opts.presetFailure) {
    elements.push({ tag: 'markdown', content: `<font color='red'>身份配置 MISS：${escapeMarkdown(opts.presetFailure)}</font>` })
  }
  if (opts.failures.length) {
    elements.push({
      tag: 'collapsible_panel',
      header: { title: { tag: 'plain_text', content: `MISS · ${opts.failures.length} 个账号` } },
      expanded: false,
      elements: [{
        tag: 'markdown',
        content: opts.failures.map(failure => `- **${escapeMarkdown(failure.display)}**：${escapeMarkdown(failure.reason)}`).join('\n'),
      }],
    })
  }
  elements.push(...opts.catalog.map(identity => identityRow(opts.panelId, identity)))
  elements.push(pager(opts))
  if (opts.presets.length) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**自定义身份 · ${opts.presets.length}**` })
    elements.push(...opts.presets.map(preset => presetRow(opts.panelId, preset)))
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🧠 reviewers' }, template: opts.notice?.type === 'error' ? 'red' : 'purple' },
    body: { elements },
  }
}

export function consultIdentityRoleCard(opts: {
  panelId: string
  identity: ConsultIdentity
}): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '选择评审角色' }, template: 'purple' },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `底层身份：**${escapeMarkdown(opts.identity.displayName)}**`,
            `模型：${inlineCode(opts.identity.model)}`,
            `effort：${inlineCode('max')}`,
          ].join('\n'),
        },
        ...roleRows(opts.panelId, opts.identity.id),
        backButton(opts.panelId),
      ],
    },
  }
}

export function consultIdentityDeleteCard(opts: {
  panelId: string
  preset: ConsultIdentityPreset
}): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '删除全局身份' }, template: 'red' },
    body: {
      elements: [
        { tag: 'markdown', content: `<font color='red'>确认删除 **${escapeMarkdown(opts.preset.name)}**？这会影响所有项目群。</font>` },
        {
          tag: 'column_set',
          columns: [
            buttonColumn('取消', 'default', { kind: 'consult_identity_back', panel_id: opts.panelId }),
            buttonColumn('确认删除', 'danger', {
              kind: 'consult_identity_delete_confirm',
              panel_id: opts.panelId,
              preset_id: opts.preset.id,
            }),
          ],
        },
      ],
    },
  }
}

export function consultRunCard(run: ConsultRunSnapshot): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: run.status === 'running',
      summary: { content: consultRunSummary(run) },
    },
    header: {
      title: { tag: 'plain_text', content: `🧠 ${run.kind}` },
      template: run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : 'purple',
    },
    body: {
      elements: [
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'plain_text', content: `咨询目标 · ${targetLabel(run)}` } },
          expanded: false,
          elements: [{
            tag: 'markdown',
            content: [
              run.question ? `**问题**\n${sanitizeMarkdownForCardKit(run.question)}` : '',
              run.instructions ? `**要求**\n${sanitizeMarkdownForCardKit(run.instructions)}` : '',
              `fingerprint: ${inlineCode(run.targetFingerprint.slice(0, 16))}`,
              run.crossReview ? '交叉复核：开启' : '交叉复核：关闭',
            ].filter(Boolean).join('\n\n'),
          }],
        },
        ...run.reviewers.map(consultReviewerElement),
        consultRunFooterElement(run),
      ],
    },
  }
}

export function consultReviewerElement(result: ConsultReviewerResult): object {
  const status = reviewerStatusLabel(result)
  const body: string[] = [`**${escapeMarkdown(status)}**`]
  if (result.output) body.push('', truncate(sanitizeMarkdownForCardKit(result.output), 7000))
  if (result.error) body.push('', `<font color='red'>${sanitizeMarkdownForCardKit(result.error)}</font>`)
  if (!result.output && !result.error) body.push('', '_等待结果…_')
  body.push('', `${inlineCode(result.tokenSourceId)} · ${inlineCode(result.model)} · ${inlineCode(result.effort)}`)
  return {
    tag: 'collapsible_panel',
    element_id: consultReviewerElementId(result.identityId),
    header: { title: { tag: 'plain_text', content: `${status} · ${shortText(result.identityName, 48)}` } },
    expanded: result.status === 'failed',
    elements: [{ tag: 'markdown', content: body.join('\n') }],
  }
}

export function consultRunFooterElement(run: ConsultRunSnapshot): object {
  const completed = run.reviewers.filter(item => item.status === 'completed').length
  const failed = run.reviewers.filter(item => item.status === 'failed').length
  const cancelled = run.reviewers.filter(item => item.status === 'cancelled').length
  const status = run.status === 'completed'
    ? '✅ 咨询完成'
    : run.status === 'failed'
      ? '❌ 咨询失败'
      : run.status === 'cancelled'
        ? '🛑 咨询已取消'
        : '⏳ 咨询中'
  return {
    tag: 'markdown',
    element_id: ELEMENTS.consultRunFooter,
    content: `${status} · 完成 ${completed}/${run.reviewers.length} · 失败 ${failed} · 取消 ${cancelled}`,
  }
}

export function consultReviewerElementId(identityId: string): string {
  return `cr_${createHash('sha256').update(identityId).digest('hex').slice(0, 16)}`
}

export function consultRunSummary(run: ConsultRunSnapshot): string {
  const done = run.reviewers.filter(item => item.status === 'completed').length
  return `${run.status === 'running' ? '⏳' : run.status === 'completed' ? '✅' : run.status === 'cancelled' ? '🛑' : '❌'} ${run.kind} · ${done}/${run.reviewers.length}`
}

function identityRow(panelId: string, identity: ConsultIdentity): object {
  const ready = identity.status === 'ready'
  const detail = ready ? 'ready' : `${identity.status}: ${identity.reason ?? 'MISS'}`
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 4,
        elements: [{
          tag: 'markdown',
          content: `**${escapeMarkdown(identity.displayName)}**\n${inlineCode(identity.model)} · max · ${escapeMarkdown(detail)}`,
        }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1,
        elements: [ready
          ? actionButton('添加', 'primary', { kind: 'consult_identity_add', panel_id: panelId, identity_id: identity.id })
          : { tag: 'markdown', content: '`MISS`' }],
      },
    ],
  }
}

function presetRow(panelId: string, preset: ConsultIdentityPreset): object {
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 4,
        elements: [{
          tag: 'markdown',
          content: `**${escapeMarkdown(preset.name)}**\n${roleLabel(preset.role)} · ${preset.enabled ? '已启用' : '已停用'}`,
        }],
      },
      buttonColumn(preset.enabled ? '停' : '启', 'default', {
        kind: 'consult_identity_toggle', panel_id: panelId, preset_id: preset.id,
      }),
      buttonColumn('删', 'danger', {
        kind: 'consult_identity_delete', panel_id: panelId, preset_id: preset.id,
      }),
    ],
  }
}

function roleRows(panelId: string, identityId: string): object[] {
  const roles: ConsultRole[] = ['general', 'correctness', 'architecture', 'security', 'testing', 'maintainability']
  const out: object[] = []
  for (let i = 0; i < roles.length; i += 2) {
    const pair = roles.slice(i, i + 2)
    out.push({
      tag: 'column_set',
      columns: pair.map(role => buttonColumn(roleLabel(role), role === 'general' ? 'default' : 'primary', {
        kind: 'consult_identity_role',
        panel_id: panelId,
        identity_id: identityId,
        role,
      })),
    })
  }
  return out
}

function pager(opts: ConsultIdentityListCardOpts): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('上一页', 'default', { kind: 'consult_identity_page', panel_id: opts.panelId, page: Math.max(0, opts.page - 1) }),
      buttonColumn('刷新', 'default', { kind: 'consult_identity_page', panel_id: opts.panelId, page: opts.page }),
      buttonColumn('下一页', 'default', { kind: 'consult_identity_page', panel_id: opts.panelId, page: Math.min(opts.totalPages - 1, opts.page + 1) }),
    ],
  }
}

function backButton(panelId: string): object {
  return {
    tag: 'column_set',
    columns: [buttonColumn('返回', 'default', { kind: 'consult_identity_back', panel_id: panelId })],
  }
}

function buttonColumn(text: string, type: string, value: Record<string, unknown>): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [actionButton(text, type, value)],
  }
}

function actionButton(text: string, type: string, value: Record<string, unknown>): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  }
}

function noticeElement(notice: ConsultIdentityPanelNotice): object {
  const color = notice.type === 'error' ? 'red' : notice.type === 'success' ? 'green' : 'grey'
  return { tag: 'markdown', content: `<font color='${color}'>${escapeMarkdown(notice.content)}</font>` }
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function reviewerStatusLabel(result: ConsultReviewerResult): string {
  switch (result.status) {
    case 'completed': return '✅ 完成'
    case 'failed': return '❌ 失败'
    case 'cancelled': return '🛑 取消'
    case 'running': return '⏳ 评审中'
    default: return '⏳ 排队中'
  }
}

function targetLabel(run: ConsultRunSnapshot): string {
  switch (run.target.type) {
    case 'commit': return `commit ${run.target.sha}`
    case 'base_branch': return `${run.target.branch}...HEAD`
    case 'proposal': return '方案文本'
    case 'uncommitted_changes': return '未提交变更'
    default: return '当前工作目录'
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 24)}\n\n_卡片输出已截断，完整结果由 CLI 返回。_`
}

function shortText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
