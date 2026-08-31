import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFeishuMock, sentCards, sentRawTexts } from './feishu-test-mock'

const { showAgentIdentityPanel } = await import('./session-agent-identities')

beforeEach(() => resetFeishuMock())

describe('global Agents panel ownership', () => {
  test('refuses to create a panel without an operator id', async () => {
    await showAgentIdentityPanel({ chatId: 'chat-1' } as any, '')
    expect(sentCards).toHaveLength(0)
    expect(sentRawTexts).toEqual(['❌ 无法确认操作者身份，未打开 agents 面板'])
  })
})
