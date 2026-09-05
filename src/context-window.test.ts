import { describe, expect, test } from 'bun:test'

import {
  contextLimitFromAppServer,
  contextPercentSummary,
  contextRemainingPercent,
  contextTokenRatioLabel,
  contextTokensFromUsage,
  rawContextPercentLabel,
} from './context-window'

describe('context window display', () => {
  test('uses latest total tokens as current occupancy', () => {
    expect(contextTokensFromUsage({
      total_tokens: 35_211,
      input_tokens: 35_190,
      cache_read_input_tokens: 4_480,
      output_tokens: 21,
    })).toBe(35_211)
  })

  test('uses app-server effective context window and Codex baseline percentage', () => {
    const limit = contextLimitFromAppServer(258_400)

    expect(limit).toBe(258_400)
    expect(contextRemainingPercent(35_211, limit)).toBe(91)
    expect(contextPercentSummary(35_211, limit)).toEqual({ used: 9, remaining: 91 })
    expect(contextTokenRatioLabel(70_123, limit)).toBe('70K/258K')
    expect(contextTokenRatioLabel(70_123, null)).toBe('70K/--')
  })

  test('formats raw context window occupancy for compact completion', () => {
    const limit = contextLimitFromAppServer(258_000)

    expect(rawContextPercentLabel(35_211, limit)).toBe('14%')
    expect(rawContextPercentLabel(1_000, limit)).toBe('<1%')
    expect(rawContextPercentLabel(0, limit)).toBe('0%')
    expect(rawContextPercentLabel(35_211, null)).toBe('--')
  })

  test('keeps missing or invalid app-server windows unknown', () => {
    expect(contextLimitFromAppServer(null)).toBeNull()
    expect(contextLimitFromAppServer(0)).toBeNull()
    expect(contextLimitFromAppServer(Number.NaN)).toBeNull()
  })

  test('baseline=0 yields pure tokens/limit ratio (Claude path, no Codex 12K baseline)', () => {
    const limit = contextLimitFromAppServer(100_000)
    // 87K / 100K = 87%,不扣 12K baseline
    expect(contextRemainingPercent(87_000, limit, 0)).toBe(13)
    expect(contextPercentSummary(87_000, limit, 0)).toEqual({ used: 87, remaining: 13 })
    // 不传 baseline → 默认 12K(Codex 口径),同一组数结果不同
    expect(contextPercentSummary(87_000, limit)?.used).not.toBe(87)
  })

  test('keeps missing total token counts unknown', () => {
    expect(contextTokensFromUsage({
      input_tokens: 35_190,
      output_tokens: 21,
    })).toBeNull()
  })
})
