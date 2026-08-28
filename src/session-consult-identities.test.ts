import { beforeEach, describe, expect, test } from 'bun:test'
import {
  resetFeishuMock,
  sentCards,
  sentRawTexts,
} from './feishu-test-mock'

const { showConsultIdentityPanel } = await import('./session-consult-identities')

beforeEach(() => resetFeishuMock())

describe('global reviewers panel ownership', () => {
  test('refuses to create a globally mutable panel without an operator id', async () => {
    await showConsultIdentityPanel({ chatId: 'chat-1' } as any, '')
    expect(sentCards).toHaveLength(0)
    expect(sentRawTexts).toEqual(['❌ 无法确认操作者身份，未打开全局 reviewers 面板'])
  })
})
