import { describe, expect, test } from 'bun:test'

import { updateUsageFromRateLimits } from './usage'

describe('usage cache semantics', () => {
  test('keeps last live snapshot when a later live update payload is empty', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 12.4, windowDurationMins: 300 },
      secondary: { usedPercent: 66.6, windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(12.4)
    expect(snapshot.weekly?.percent).toBe(66.6)

    const kept = updateUsageFromRateLimits(null)
    expect(kept).toEqual(snapshot)
  })

  test('does not coerce missing usage percentages to 0', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'pro',
      primary: { windowDurationMins: 300 },
      secondary: { windowDurationMins: 10_080 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBeNull()
    expect(snapshot.weekly?.percent).toBeNull()
  })

  test('prolite 形态:唯一周窗口在 primary(secondary=null),按时长归类不按位置', () => {
    // 2026-08-17 实测 prolite 账号 account/rateLimits/read:primary 是 7 天窗口。
    const snapshot = updateUsageFromRateLimits({
      planType: 'prolite',
      primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
      secondary: null,
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour).toBeNull()
    expect(snapshot.weekly?.percent).toBe(9)
    expect(snapshot.weekly?.durationMins).toBe(10_080)
  })

  test('倒挂形态:primary=周、secondary=5h,按时长纠正归位', () => {
    const snapshot = updateUsageFromRateLimits({
      planType: 'plus',
      primary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_787_561_037 },
      secondary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    })

    expect(snapshot.state).toBe('ok')
    if (snapshot.state !== 'ok') throw new Error('expected ok snapshot')
    expect(snapshot.fiveHour?.percent).toBe(7)
    expect(snapshot.weekly?.percent).toBe(17)
  })
})
