import { describe, expect, test } from 'bun:test'
import { parseRunArgs } from './consult-cli'

describe('lodestar-consult CLI args', () => {
  test('parses parallel cross-review request', () => {
    expect(parseRunArgs([
      '--identity', 'a', '--identity', 'b', '--kind', 'review',
      '--target', 'uncommitted_changes', '--cross-review',
    ])).toMatchObject({
      identityIds: ['a', 'b'],
      kind: 'review',
      target: 'uncommitted_changes',
      crossReview: true,
      readStdin: false,
    })
  })

  test('proposal mode reads stdin when inline text is absent', () => {
    expect(parseRunArgs(['--identity', 'a', '--kind', 'review', '--target', 'proposal']))
      .toMatchObject({ target: 'proposal', readStdin: true })
  })

  test('requires identities', () => {
    expect(() => parseRunArgs(['--kind', 'question', 'hello'])).toThrow('--identity')
  })
})
