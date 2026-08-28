import { describe, expect, test } from 'bun:test'
import { parseConsultRunRequest } from './consult-types'

describe('parseConsultRunRequest', () => {
  test('normalizes identity ids and review target', () => {
    expect(parseConsultRunRequest({
      identity_ids: ['a', 'a', 'b'],
      kind: 'review',
      target: { type: 'uncommitted_changes' },
      cross_review: true,
    })).toEqual({
      identityIds: ['a', 'b'],
      kind: 'review',
      target: { type: 'uncommitted_changes' },
      question: '',
      instructions: '',
      crossReview: true,
    })
  })

  test('requires a question for question mode', () => {
    expect(() => parseConsultRunRequest({ identity_ids: ['a'], kind: 'question' }))
      .toThrow('requires "question"')
  })

  test('rejects unknown targets and empty identities', () => {
    expect(() => parseConsultRunRequest({ identity_ids: [], kind: 'review' })).toThrow('identity_id')
    expect(() => parseConsultRunRequest({ identity_ids: ['a'], kind: 'review', target: { type: 'mystery' } }))
      .toThrow('unsupported consult target')
  })

  test('bounds cross-review fanout without limiting ordinary catalog consultations', () => {
    const ids = Array.from({ length: 9 }, (_, index) => `id-${index}`)
    expect(() => parseConsultRunRequest({ identity_ids: ids, kind: 'question', question: 'x', cross_review: true }))
      .toThrow('at most 8')
    expect(parseConsultRunRequest({ identity_ids: ids, kind: 'question', question: 'x' }).identityIds)
      .toHaveLength(9)
  })
})
