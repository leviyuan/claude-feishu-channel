import { describe, expect, test } from 'bun:test'
import { notifySkillBody } from './notify-skill'

describe('feishu-notify managed skill', () => {
  test('serializes the description as a YAML-safe JSON string', () => {
    const body = notifySkillBody(9876)
    const line = body.split('\n').find(value => value.startsWith('description: '))
    expect(line).toBeDefined()
    expect(() => JSON.parse(line!.slice('description: '.length))).not.toThrow()
    expect(JSON.parse(line!.slice('description: '.length))).toContain('interactive buttons:')
  })
})
