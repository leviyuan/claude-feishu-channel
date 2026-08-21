import { describe, expect, test } from 'bun:test'
import { isStaleAtReceipt } from './inbound-message'

describe('inbound message freshness', () => {
  test('a fresh accepted message stays fresh even when FIFO processing starts much later', () => {
    const receivedAt = 1_000_000
    const createTime = receivedAt - 1_000

    expect(isStaleAtReceipt(createTime, receivedAt, 30_000)).toBe(false)
    // Processing time is intentionally absent from the API; a 120s queue wait
    // cannot age an already-accepted message into a replay.
  })

  test('rejects a message that was already stale when accepted', () => {
    const receivedAt = 1_000_000
    expect(isStaleAtReceipt(receivedAt - 30_001, receivedAt, 30_000)).toBe(true)
  })
})
