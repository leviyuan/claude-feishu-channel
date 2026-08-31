import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeManagedSkill, syncClaudePluginSkill, syncManagedSkill } from './managed-skills'

describe('managed skill sync', () => {
  test('installs to every backend root and updates daemon-owned content', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-skills-'))
    const codex = join(root, 'codex')
    const claude = join(root, 'claude')
    syncManagedSkill({ name: 'test-skill', body: 'v1\n' }, [codex, claude])
    const codexFile = join(codex, 'test-skill', 'SKILL.md')
    const claudeFile = join(claude, 'test-skill', 'SKILL.md')
    expect(readFileSync(codexFile, 'utf8')).toBe('v1\n')
    expect(readFileSync(claudeFile, 'utf8')).toBe('v1\n')
    expect(statSync(codexFile).mode & 0o777).toBe(0o600)

    syncManagedSkill({ name: 'test-skill', body: 'v2\n' }, [codex, claude])
    expect(readFileSync(codexFile, 'utf8')).toBe('v2\n')
    expect(readFileSync(claudeFile, 'utf8')).toBe('v2\n')
  })

  test('accumulates every managed Skill in one Claude SDK plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-plugin-'))
    const plugin = join(root, 'plugin')
    syncClaudePluginSkill({ name: 'feishu-notify', body: 'notify-v1\n' }, plugin)
    syncClaudePluginSkill({ name: 'lodestar-agent', body: 'agent-v1\n' }, plugin)
    expect(JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')))
      .toMatchObject({ name: 'lodestar-managed' })
    expect(readFileSync(join(plugin, 'skills', 'feishu-notify', 'SKILL.md'), 'utf8')).toBe('notify-v1\n')
    expect(readFileSync(join(plugin, 'skills', 'lodestar-agent', 'SKILL.md'), 'utf8')).toBe('agent-v1\n')
  })

  test('removes an obsolete daemon-owned Skill but preserves unclear ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-managed-remove-'))
    const owned = join(root, 'lodestar-consult', 'SKILL.md')
    const custom = join(root, 'custom', 'SKILL.md')
    mkdirSync(join(root, 'lodestar-consult'), { recursive: true })
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(owned, '---\nname: lodestar-consult\n---\n')
    writeFileSync(custom, 'user content\n')
    removeManagedSkill('lodestar-consult', [root])
    removeManagedSkill('custom', [root])
    expect(existsSync(owned)).toBe(false)
    expect(existsSync(custom)).toBe(true)
  })
})
