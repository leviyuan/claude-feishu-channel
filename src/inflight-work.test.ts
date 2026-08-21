import { describe, expect, test } from 'bun:test'
import { drainDynamicWork, trackWork } from './inflight-work'

describe('dynamic in-flight work drain', () => {
  test('waits for a follow-up added by work that was already being drained', async () => {
    const work = new Set<Promise<unknown>>()
    let releaseOuter: () => void = () => {}
    const outerGate = new Promise<void>(resolve => { releaseOuter = resolve })
    let releaseFollowup: () => void = () => {}
    const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve })

    const outer = outerGate.then(() => {
      trackWork(work, followupGate)
    })
    trackWork(work, outer)
    let drained = false
    const drain = drainDynamicWork(() => work).then(() => { drained = true })

    releaseOuter()
    await outer
    await new Promise(resolve => queueMicrotask(resolve))
    expect(drained).toBe(false)

    releaseFollowup()
    await drain
    expect(drained).toBe(true)
    expect(work.size).toBe(0)
  })

  test('rejected work is removed and does not poison the drain', async () => {
    const work = new Set<Promise<unknown>>()
    trackWork(work, Promise.reject(new Error('expected')))
    await drainDynamicWork(() => work)
    expect(work.size).toBe(0)
  })
})
