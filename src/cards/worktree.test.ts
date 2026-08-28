import { describe, expect, test } from 'bun:test'

import { type WorktreeCardEntry, worktreeListCard } from './worktree'

describe('worktree card rendering', () => {
  test('summarizes hidden merged unmounted branches without rendering their details', () => {
    const card = worktreeListCard({
      projectName: 'feishu',
      projectDir: '/tmp/feishu',
      hiddenMergedUnmountedCount: 2,
      entries: [entry({ slug: 'active-work' })],
    }) as any

    const json = JSON.stringify(card)
    expect(card.body.elements[0].content).toBe('2个已归档分支')
    expect(json).toContain('active-work')
    expect(json).not.toContain('merged-hidden')
  })

  test('renders repository states by priority with direct Chinese labels', () => {
    const card = worktreeListCard({
      projectName: 'feishu',
      projectDir: '/tmp/feishu',
      entries: [
        entry({ slug: 'error-work', error: 'status failed', dirtyCount: 3, state: 'merged' }),
        entry({ slug: 'dirty-work', dirtyCount: 2, state: 'stale' }),
        entry({ slug: 'merged-work', state: 'merged' }),
        entry({ slug: 'stale-work', state: 'stale', mounted: false }),
        entry({ slug: 'off-work', mounted: false }),
        entry({ slug: 'clean-work' }),
      ],
    }) as any

    const json = JSON.stringify(card)
    expect(json).toContain('出错')
    expect(json).toContain('有未提交改动 2')
    expect(json).toContain('已合并')
    expect(json).toContain('两边都有新改动')
    expect(json).toContain('未挂载')
    expect(json).toContain('进行中')
  })

  test('renders action notices at the top of the list card', () => {
    const card = worktreeListCard({
      projectName: 'feishu',
      projectDir: '/tmp/feishu',
      notice: { type: 'success', content: '✅ feature 已解散' },
      entries: [entry({ slug: 'feature' })],
    }) as any

    expect(card.header.template).toBe('green')
    expect(card.body.elements[0].content).toContain('feature 已解散')
    expect(JSON.stringify(card.body.elements[1])).toContain('feature')
  })

})

function entry(overrides: Partial<WorktreeCardEntry>): WorktreeCardEntry {
  const slug = overrides.slug ?? 'work'
  return {
    slug,
    chatName: `feishu[${slug}]`,
    branch: `work/${slug}`,
    state: 'active',
    path: `/tmp/feishu[${slug}]`,
    mounted: true,
    dirtyCount: 0,
    statusLine: `work/${slug}`,
    error: null,
    chatId: null,
    duplicateChatCount: 0,
    ...overrides,
  }
}
