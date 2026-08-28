import { describe, expect, test } from 'bun:test'
import { consultSkillBody } from './consult-skill'

describe('lodestar-consult managed skill', () => {
  test('has broad review/consult triggers and mandates live identity discovery', () => {
    const body = consultSkillBody()
    expect(body).toContain('name: lodestar-consult')
    expect(body).toContain('让 DeepSeek 审查')
    expect(body).toContain('问一下 GLM5.3')
    expect(body).toContain('every review request')
    expect(body.indexOf('lodestar-consult identities --json'))
      .toBeLessThan(body.indexOf('lodestar-consult run'))
    expect(body).toContain('never invent or substitute a model')
    expect(body).toContain('exactly one command')
    expect(body).toContain('Never launch one `lodestar-consult run` per identity')
    expect(body).toContain("--identity '<identity-id-1>' --identity '<identity-id-2>'")
    const description = body.split('\n').find(line => line.startsWith('description: '))
    expect(description).toBeDefined()
    expect(() => JSON.parse(description!.slice('description: '.length))).not.toThrow()
    expect(body).toContain('# desc:')
  })
})
