import { ELEMENTS } from './elements'
import type { TasklistBinding } from '../tasklist'

export interface TasklistPanelNotice {
  type: 'success' | 'error' | 'info'
  content: string
}

export interface TasklistPanelOpts {
  projectName: string
  tasklistName: string
  binding?: TasklistBinding | null
  notice?: TasklistPanelNotice
  confirmDelete?: boolean
}

export function tasklistPanelCard(opts: TasklistPanelOpts): object {
  const enabled = !!opts.binding
  const template = opts.notice?.type === 'error'
    ? 'red'
    : opts.confirmDelete
      ? 'red'
      : enabled
        ? 'green'
        : 'blue'
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'task' },
      template,
    },
    body: {
      elements: [
        ...(opts.notice ? [noticeElement(opts.notice)] : []),
        {
          tag: 'markdown',
          element_id: ELEMENTS.tasklistPanel,
          content: panelContent(opts),
        },
        actionElement(opts),
      ],
    },
  }
}

function panelContent(opts: TasklistPanelOpts): string {
  const lines = [
    `项目：${inlineCode(opts.projectName)}`,
    `清单：${inlineCode(opts.tasklistName)}`,
  ]
  if (!opts.binding) {
    lines.push('', '未启用')
    return lines.join('\n')
  }
  lines.push('', '已启用')
  lines.push(`GUID：${inlineCode(opts.binding.guid)}`)
  if (opts.binding.url) lines.push(`链接：${opts.binding.url}`)
  if (opts.confirmDelete) {
    lines.push('')
    lines.push(`<font color='red'>确认后会删除该清单以及清单内所有任务。</font>`)
  }
  return lines.join('\n')
}

function actionElement(opts: TasklistPanelOpts): object {
  if (!opts.binding) {
    return {
      tag: 'column_set',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '启用' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { kind: 'tasklist_enable' } }],
        }],
      }],
    }
  }

  if (opts.confirmDelete) {
    return {
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 4,
          elements: [{
            tag: 'markdown',
            content: `<font color='red'>会删除所有清单内任务</font>`,
          }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '确认' },
            type: 'danger',
            behaviors: [{ type: 'callback', value: { kind: 'tasklist_delete_confirm', guid: opts.binding.guid } }],
          }],
        },
      ],
    }
  }

  return {
    tag: 'column_set',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '删' },
        type: 'danger',
        behaviors: [{ type: 'callback', value: { kind: 'tasklist_delete_prompt', guid: opts.binding.guid } }],
      }],
    }],
  }
}

function noticeElement(notice: TasklistPanelNotice): object {
  const color = notice.type === 'error'
    ? 'red'
    : notice.type === 'success'
      ? 'green'
      : 'grey'
  return {
    tag: 'markdown',
    content: notice.content
      .split('\n')
      .map(line => `<font color='${color}'>${escapeMarkdown(line) || ' '}</font>`)
      .join('\n'),
  }
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}

function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
