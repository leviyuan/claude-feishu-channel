export interface WorktreeCardEntry {
  slug: string
  chatName: string
  branch: string
  state: 'active' | 'merged' | 'stale'
  path: string
  mounted: boolean
  dirtyCount: number | null
  statusLine: string | null
  error: string | null
  chatId: string | null
  duplicateChatCount: number
}

export interface WorktreeListCardOpts {
  projectName: string
  projectDir: string
  entries: WorktreeCardEntry[]
  hiddenMergedUnmountedCount?: number
  notice?: WorktreeListNotice
}

export interface WorktreeNoticeCardOpts {
  slug: string
  branch: string
  status: string
  body?: string
  template?: string
}

export interface WorktreeListNotice {
  type: 'success' | 'error' | 'info'
  content: string
}

export function worktreeListCard(opts: WorktreeListCardOpts): object {
  const summary = worktreeListSummary(opts)
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '🌿 wt' },
      template: worktreeListHeaderTemplate(opts.notice),
    },
    body: {
      elements: [
        ...(opts.notice ? [worktreeListNoticeElement(opts.notice)] : []),
        ...(summary ? [{ tag: 'markdown', content: summary }] : []),
        ...opts.entries.flatMap(worktreeEntryElements),
      ],
    },
  }
}

function worktreeListHeaderTemplate(notice?: WorktreeListNotice): string {
  if (notice?.type === 'error') return 'red'
  if (notice?.type === 'success') return 'green'
  return 'turquoise'
}

function worktreeListNoticeElement(notice: WorktreeListNotice): object {
  const color = notice.type === 'error'
    ? 'red'
    : notice.type === 'success'
      ? 'green'
      : 'grey'
  return {
    tag: 'markdown',
    content: notice.content
      .split('\n')
      .map(line => `<font color='${color}'>${line || ' '}</font>`)
      .join('\n'),
  }
}

function worktreeListSummary(opts: WorktreeListCardOpts): string {
  const hidden = opts.hiddenMergedUnmountedCount ?? 0
  if (!opts.entries.length && hidden === 0) {
    return `_无 work/* 分支。发 ${inlineCode('wt name')} 创建。_`
  }

  if (hidden > 0) return `${hidden}个已归档分支`
  return ''
}

function worktreeEntryElements(entry: WorktreeCardEntry): object[] {
  const repoState = entry.error
    ? '出错'
    : entry.mounted && entry.dirtyCount && entry.dirtyCount > 0
      ? `有未提交改动 ${entry.dirtyCount}`
      : entry.state === 'merged'
        ? '已合并'
        : entry.state === 'stale'
          ? '两边都有新改动'
          : entry.mounted
            ? '进行中'
            : '未挂载'
  const chatState = entry.duplicateChatCount > 1
    ? `群重复 ${entry.duplicateChatCount} 个`
    : entry.chatId
      ? '群正常'
      : '无群'
  const columns: object[] = [{
    tag: 'column',
    width: 'weighted',
    weight: 4,
    elements: [{
      tag: 'markdown',
      content: `**${inlineCode(entry.slug)}**\n${repoState} · ${chatState}\n${inlineCode(entry.branch)}`,
    }],
  }]
  if (entry.mounted || entry.chatId) {
    columns.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '删' },
        type: 'danger',
        behaviors: [{ type: 'callback', value: { kind: 'worktree_disband', slug: entry.slug } }],
      }],
    })
  }
  return [{ tag: 'column_set', columns }]
}

export function worktreeNoticeCard(opts: WorktreeNoticeCardOpts): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🌿 ${opts.slug}` },
      template: opts.template ?? 'green',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: [
          opts.status,
          inlineCode(opts.branch),
          ...(opts.body ? [opts.body] : []),
        ].join('\n'),
      }],
    },
  }
}

function inlineCode(s: string): string {
  return '`' + s.replace(/`/g, '\\`') + '`'
}
