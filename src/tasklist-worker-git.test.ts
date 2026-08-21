import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAutomationWorktree } from './tasklist-worker-git'

describe('automation worktree base CAS', () => {
  test('rejects when project HEAD changes after the execution base was captured', () => {
    const root = mkdtempSync(join(tmpdir(), 'lodestar-worker-base-'))
    const repo = join(root, 'project')
    try {
      git(root, ['init', 'project'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'file.txt'), 'one\n')
      git(repo, ['add', '.'])
      git(repo, ['commit', '-m', 'one'])
      const captured = git(repo, ['rev-parse', 'HEAD']).trim()

      writeFileSync(join(repo, 'file.txt'), 'two\n')
      git(repo, ['commit', '-am', 'two'])

      expect(() => prepareAutomationWorktree(repo, 'project', 'AI-AUTO', captured))
        .toThrow('project HEAD changed before worktree prepare')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
