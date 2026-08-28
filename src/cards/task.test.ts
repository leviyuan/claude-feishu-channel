import { describe, expect, test } from 'bun:test'

import { tasklistPanelCard } from './task'

const binding = {
  guid: 'tl-guid-1',
  name: 'feishu[lodestar]',
  url: 'https://applink.feishu.cn/client/todo/task_list?guid=tl-guid-1',
  projectName: 'feishu',
  ownerOpenId: 'ou_owner',
}

describe('tasklist panel card rendering', () => {
  test('renders disabled panel with only enable action', () => {
    const card = tasklistPanelCard({
      projectName: 'feishu',
      tasklistName: 'feishu[lodestar]',
      binding: null,
    }) as any

    const json = JSON.stringify(card)
    expect(card.header.title.content).toBe('task')
    expect(json).toContain('未启用')
    expect(json).toContain('启用')
    expect(json).toContain('tasklist_enable')
    expect(json).not.toContain('tasklist_delete_prompt')
    expect(json).not.toContain('tasklist_delete_confirm')
  })

  test('renders enabled panel with delete action', () => {
    const card = tasklistPanelCard({
      projectName: 'feishu',
      tasklistName: 'feishu[lodestar]',
      binding,
    }) as any

    const json = JSON.stringify(card)
    expect(json).toContain('已启用')
    expect(json).not.toContain('[AI]')
    expect(json).toContain('tl-guid-1')
    expect(json).toContain('tasklist_delete_prompt')
    expect(json).not.toContain('tasklist_delete_confirm')
  })

  test('renders delete confirmation warning and confirm action', () => {
    const card = tasklistPanelCard({
      projectName: 'feishu',
      tasklistName: 'feishu[lodestar]',
      binding,
      confirmDelete: true,
    }) as any

    const json = JSON.stringify(card)
    expect(card.header.template).toBe('red')
    expect(json).toContain('会删除所有清单内任务')
    expect(json).toContain('确认')
    expect(json).toContain('tasklist_delete_confirm')
  })
})
