import { describe, expect, test } from 'bun:test'
import { agentSkillBody } from './agent-skill'

describe('lodestar-agent managed Skill', () => {
  test('describes a selected identity as its corresponding Agent call', () => {
    const body = agentSkillBody()
    expect(body).toContain('corresponding Agent')
    expect(body).toContain('provider Agent backend')
    expect(body).toContain("caller-supplied prompt becomes that Agent run's task")
    expect(body).toContain('lodestar-agent follow-up')
    expect(body).toContain('lodestar-agent answer')
    expect(body.toLowerCase()).not.toContain('reviewer')
    expect(body.toLowerCase()).not.toContain('read-only')
  })
})
