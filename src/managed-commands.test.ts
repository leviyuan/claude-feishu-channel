import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureLodestarAgentCommand,
  resolveAgentCliLaunch,
} from './managed-commands'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-command-'))
  roots.push(root)
  return root
}

describe('managed lodestar-agent command', () => {
  test('resolves Bun source and Node release layouts without substituting a missing entry', () => {
    expect(resolveAgentCliLaunch({
      daemonEntry: '/repo/daemon.ts',
      runtime: '/opt/bun/bin/bun',
      exists: (path: string) => path === '/repo/src/agent-cli.ts',
    })).toEqual({ runtime: '/opt/bun/bin/bun', entry: '/repo/src/agent-cli.ts' })
    expect(resolveAgentCliLaunch({
      daemonEntry: '/pkg/dist/lodestar.js',
      runtime: '/usr/bin/node',
      exists: (path: string) => path === '/pkg/dist/lodestar-agent.js',
    })).toEqual({ runtime: '/usr/bin/node', entry: '/pkg/dist/lodestar-agent.js' })
    expect(() => resolveAgentCliLaunch({
      daemonEntry: '/missing/daemon.ts', runtime: '/opt/bun/bin/bun', exists: () => false,
    })).toThrow('entry not found')
  })

  test('atomically installs an executable wrapper and prepends its directory to PATH', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const target = ensureLodestarAgentCommand({
      platform: 'linux',
      targetDir,
      launch: { runtime: "/opt/bun's/bin/bun", entry: '/repo/src/agent-cli.ts' },
      env,
    })
    expect(readFileSync(target, 'utf8')).toContain(`exec '/opt/bun'"'"'s/bin/bun' '/repo/src/agent-cli.ts' "$@"`)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(env.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('removes only the obsolete daemon-owned consult wrapper', () => {
    const targetDir = join(tempRoot(), 'bin')
    const legacy = join(targetDir, 'lodestar-consult')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(legacy, "#!/bin/sh\nexec bun /repo/src/consult-cli.ts \"$@\"\n", { mode: 0o700 })
    ensureLodestarAgentCommand({
      platform: 'linux', targetDir,
      launch: { runtime: '/opt/bun/bin/bun', entry: '/repo/src/agent-cli.ts' },
      env: { PATH: '/usr/bin' },
    })
    expect(existsSync(legacy)).toBe(false)
  })

  test('writes a Windows command wrapper and updates Path case-insensitively', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const target = ensureLodestarAgentCommand({
      platform: 'win32',
      targetDir,
      launch: { runtime: 'C:\\Bun\\bun.exe', entry: 'C:\\Lodestar\\agent.js' },
      env,
    })
    expect(target.endsWith('lodestar-agent.cmd')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\agent.js" %*\r\n')
    expect(env.Path).toBe(`${targetDir};C:\\Windows`)
  })
})
