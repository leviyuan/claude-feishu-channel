import { createHash } from 'node:crypto'
import type { AgentIdentity, AgentSourceFailure } from '../agent-identities'
import type { AgentRunSnapshot, AgentWorkerResult } from '../agent-run-types'
import { ELEMENTS, sanitizeMarkdownForCardKit } from './elements'

const PROMPT_PREVIEW_CHARS = 10_000
const WORKER_TOTAL_PREVIEW_CHARS = 48_000
const WORKER_MAX_PREVIEW_CHARS = 8_000
const WORKER_MIN_PREVIEW_CHARS = 512

export interface AgentIdentityListCardOpts {
  panelId: string
  page: number
  totalPages: number
  catalog: AgentIdentity[]
  failures: AgentSourceFailure[]
}

export function agentIdentityListCard(opts: AgentIdentityListCardOpts): object {
  const elements: object[] = [{
    tag: 'markdown',
    element_id: ELEMENTS.agentIdentityPanel,
    content: [
      '**全局 Agent 身份**',
      '每个 Token Source 的每个模型都是一个可直接执行任务的完整 Agent；具体约束完全来自主 Agent 传入的 prompt。',
      `目录第 ${opts.page + 1}/${opts.totalPages} 页`,
    ].join('\n'),
  }]
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
  elements.push(...opts.catalog.map(identityRow), pager(opts))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '🧠 agents' }, template: 'purple' },
    body: { elements },
  }
}

export function agentRunCard(run: AgentRunSnapshot): object {
  const previewChars = agentWorkerPreviewChars(run.workers.length)
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: !isTerminal(run.status),
      summary: { content: agentRunSummary(run) },
    },
    header: {
      title: { tag: 'plain_text', content: `🧠 agent · depth ${run.depth}` },
      template: run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : run.status === 'needs_input' ? 'orange' : 'purple',
    },
    body: {
      elements: [
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'plain_text', content: run.parentKind === 'follow_up' ? '续跑 prompt' : '任务 prompt' } },
          expanded: false,
          elements: [{ tag: 'markdown', content: promptPreview(run.prompt) }],
        },
        ...run.workers.map(worker => agentWorkerElement(worker, previewChars)),
        agentRunFooterElement(run),
      ],
    },
  }
}

export function agentWorkerElement(worker: AgentWorkerResult, outputPreviewChars = WORKER_MAX_PREVIEW_CHARS): object {
  const status = workerStatusLabel(worker)
  const body: string[] = [`**${escapeMarkdown(status)}**`]
  if (worker.pendingInput) {
    body.push('', '**等待主 Agent 回答**')
    for (const question of worker.pendingInput.questions) {
      body.push(`- ${escapeMarkdown(question.question)}`)
      if (question.options.length) body.push(`  选项：${question.options.map(option => inlineCode(option.label)).join(' / ')}`)
    }
    body.push(`request: ${inlineCode(worker.pendingInput.requestId)}`)
  }
  if (worker.output) body.push('', truncate(sanitizeMarkdownForCardKit(worker.output), outputPreviewChars))
  if (worker.error) body.push('', `<font color='red'>${sanitizeMarkdownForCardKit(worker.error)}</font>`)
  if (!worker.output && !worker.error && !worker.pendingInput) {
    body.push('', worker.status === 'completed' ? '_Agent 已完成，没有正文输出。_' : '_等待结果…_')
  }
  if (worker.steps.length) {
    body.push('', '**最近动作**')
    for (const step of worker.steps.slice(-8)) {
      const icon = step.phase === 'completed' ? '✓' : step.phase === 'started' ? '→' : '·'
      body.push(`- ${icon} ${inlineCode(step.tool)} ${escapeMarkdown(shortText(step.detail, 180))}`)
    }
  }
  body.push('', `${inlineCode(worker.tokenSourceId)} · ${inlineCode(worker.model)} · ${inlineCode(worker.effort)}`)
  if (worker.sessionId) body.push(`session: ${inlineCode(worker.sessionId)}`)
  return {
    tag: 'collapsible_panel',
    element_id: agentWorkerElementId(worker.identityId),
    header: { title: { tag: 'plain_text', content: `${status} · ${shortText(worker.identityName, 48)}` } },
    expanded: worker.status === 'failed' || worker.status === 'needs_input',
    elements: [{ tag: 'markdown', content: body.join('\n') }],
  }
}

export function agentRunFooterElement(run: AgentRunSnapshot): object {
  const completed = run.workers.filter(item => item.status === 'completed').length
  const failed = run.workers.filter(item => item.status === 'failed').length
  const waiting = run.workers.filter(item => item.status === 'needs_input').length
  const label = run.status === 'completed'
    ? '✅ Agent 完成'
    : run.status === 'failed'
      ? '❌ Agent 失败'
      : run.status === 'cancelled'
        ? '🛑 Agent 已取消'
        : run.status === 'needs_input'
          ? '❓ 等待主 Agent 输入'
          : run.status === 'queued'
            ? '⏳ Agent 排队中'
            : '⏳ Agent 运行中'
  return {
    tag: 'markdown',
    element_id: ELEMENTS.agentRunFooter,
    content: `${label} · 完成 ${completed}/${run.workers.length} · 等待 ${waiting} · 失败 ${failed}`,
  }
}

export function agentWorkerElementId(identityId: string): string {
  return `aw_${createHash('sha256').update(identityId).digest('hex').slice(0, 16)}`
}

export function agentWorkerPreviewChars(workerCount: number): number {
  const count = Math.max(1, Math.floor(workerCount))
  return Math.min(WORKER_MAX_PREVIEW_CHARS, Math.max(WORKER_MIN_PREVIEW_CHARS, Math.floor(WORKER_TOTAL_PREVIEW_CHARS / count)))
}

export function agentRunSummary(run: AgentRunSnapshot): string {
  const done = run.workers.filter(item => item.status === 'completed').length
  const icon = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : run.status === 'cancelled' ? '🛑' : run.status === 'needs_input' ? '❓' : '⏳'
  return `${icon} agent · ${done}/${run.workers.length} · depth ${run.depth}`
}

function identityRow(identity: AgentIdentity): object {
  const ready = identity.status === 'ready'
  const detail = ready ? 'ready' : `${identity.status}: ${identity.reason ?? 'MISS'}`
  return {
    tag: 'markdown',
    content: [
      `**${escapeMarkdown(identity.displayName)}** ${identity.sourceDefault ? '· default' : ''}`,
      `${inlineCode(identity.id)}\n${inlineCode(identity.model)} · 默认 ${inlineCode(identity.defaultEffort)} · ${escapeMarkdown(detail)}`,
    ].join('\n'),
  }
}

function pager(opts: AgentIdentityListCardOpts): object {
  return {
    tag: 'column_set',
    columns: [
      buttonColumn('上一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.max(0, opts.page - 1) }),
      buttonColumn('刷新', { kind: 'agent_identity_page', panel_id: opts.panelId, page: opts.page }),
      buttonColumn('下一页', { kind: 'agent_identity_page', panel_id: opts.panelId, page: Math.min(opts.totalPages - 1, opts.page + 1) }),
    ],
  }
}

function buttonColumn(text: string, value: Record<string, unknown>): object {
  return {
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type: 'default',
      behaviors: [{ type: 'callback', value }],
    }],
  }
}

function workerStatusLabel(worker: AgentWorkerResult): string {
  switch (worker.status) {
    case 'completed': return '✅ 完成'
    case 'failed': return '❌ 失败'
    case 'cancelled': return '🛑 取消'
    case 'needs_input': return '❓ 等待输入'
    case 'running': return '⏳ 运行中'
    default: return '⏳ 排队中'
  }
}

function isTerminal(status: AgentRunSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function promptPreview(value: string): string {
  const sanitized = sanitizeMarkdownForCardKit(value)
  if (sanitized.length <= PROMPT_PREVIEW_CHARS) return sanitized
  const receipt = '_卡片 prompt 预览已截断；完整 prompt 已原样交给 Agent 并持久化。_'
  return `${sanitized.slice(0, PROMPT_PREVIEW_CHARS - receipt.length - 2)}\n\n${receipt}`
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const receipt = '_卡片输出已截断，完整结果由 CLI/API 返回。_'
  return `${value.slice(0, Math.max(0, max - receipt.length - 2))}\n\n${receipt}`
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shortText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
