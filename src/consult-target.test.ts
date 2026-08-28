import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConsultTargetContext } from './consult-target'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'lodestar-consult-target-'))
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'a.txt'), 'one\n')
  git(cwd, ['add', 'a.txt'])
  git(cwd, ['commit', '-qm', 'initial'])
  return cwd
}

describe('consult target context', () => {
  test('captures uncommitted diff and changes fingerprint', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'a.txt'), 'two\n')
    const first = await buildConsultTargetContext(cwd, { type: 'uncommitted_changes' })
    expect(first.promptContext).toContain('-one')
    expect(first.promptContext).toContain('+two')
    writeFileSync(join(cwd, 'a.txt'), 'three\n')
    const second = await buildConsultTargetContext(cwd, { type: 'uncommitted_changes' })
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  test('captures a proposal without requiring Git', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'lodestar-consult-proposal-'))
    const context = await buildConsultTargetContext(cwd, { type: 'proposal', text: '方案 A' })
    expect(context.promptContext).toContain('方案 A')
    expect(context.fingerprint).toHaveLength(64)
  })

  test('rejects unsafe git refs', async () => {
    const cwd = repo()
    await expect(buildConsultTargetContext(cwd, { type: 'commit', sha: '--help' })).rejects.toThrow('invalid git ref')
  })
})
