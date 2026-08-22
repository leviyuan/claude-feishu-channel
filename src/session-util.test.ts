import { describe, expect, test } from 'bun:test'

import { diagnosticIdLabel } from './session-util'

describe('diagnosticIdLabel', () => {
  test('distinguishes concurrent UUIDv7 ids with the same timestamp prefix', () => {
    const first = '0198d6fa-1234-7000-8000-000000000001'
    const second = '0198d6fa-1234-7000-8000-000000000002'

    expect(first.slice(0, 13)).toBe(second.slice(0, 13))
    expect(diagnosticIdLabel(first)).toBe('0198d6fa…0001')
    expect(diagnosticIdLabel(second)).toBe('0198d6fa…0002')
  })

  test('does not pad short opaque ids', () => {
    expect(diagnosticIdLabel('short-id')).toBe('short-id')
  })
})
