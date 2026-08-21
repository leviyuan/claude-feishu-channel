import { describe, expect, test } from 'bun:test'
import { consoleUnifiedUsageContent } from './console'

describe('consoleUnifiedUsageContent(额度渲染)', () => {
  test('ok 态:套餐头 + 两窗口(label 不为 undefined)+ 余额 used/total', () => {
    const out = consoleUnifiedUsageContent({
      state: 'ok',
      planLabel: 'max 套餐',
      windows: [
        { kind: 'fiveHour', label: '5h 窗口', percent: 11, resetsAt: new Date(Date.now() + 3600_000) },
        { kind: 'monthly', label: '月度工具', percent: 7, used: 290, total: 4000, resetsAt: new Date(Date.now() + 86400_000 * 15) },
      ],
      fetchedAt: Date.now(),
    })
    expect(out).toContain('max 套餐')
    expect(out).toContain('5h 窗口')
    expect(out).toContain('月度工具')
    expect(out).toContain('290/4000')
    expect(out).not.toContain('undefined')  // 回归锁:glmWindowToUnified 曾漏 label → undefined 上卡
  })

  test('glm source 集成:readUsage 直渲染无 undefined', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: {
        level: 'max',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 11, nextResetTime: Date.now() + 3600_000 },
          { type: 'TIME_LIMIT', percentage: 7, currentValue: 290, usage: 4000, nextResetTime: Date.now() + 86400_000 },
        ],
      },
    }), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    try {
      await import('../token-source-glm')
      const { tokenSourceFactories } = await import('../token-source')
      const factory = tokenSourceFactories().find(candidate => candidate.kind === 'glm-coding-plan')
      expect(factory).toBeDefined()
      const glm = factory!.build({
        base_url: 'https://open.bigmodel.cn/api/anthropic',
        auth_token: 'test-token',
      })
      expect(glm.enabled).toBe(true)

      const snap = await glm.readUsage()
      expect(snap.state).toBe('ok')
      if (snap.state !== 'ok') throw new Error(`expected ok usage snapshot, got ${snap.state}`)
      const out = consoleUnifiedUsageContent(snap)
      expect(out).not.toContain('undefined')
      expect(out).toMatch(/5h 窗口|月度工具/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('planLabel-only(标量余额)不显示无数据', () => {
    const out = consoleUnifiedUsageContent({
      state: 'ok',
      planLabel: '剩余 ¥12.34',
      windows: [],
      fetchedAt: Date.now(),
    })
    expect(out).toContain('剩余 ¥12.34')
    expect(out).not.toContain('无数据')
  })
})
