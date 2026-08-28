import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureLodestarConsultCommand,
  resolveConsultCliLaunch,
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

describe('managed lodestar-consult command', () => {
  test('resolves Bun source and Node release layouts without substituting a missing entry', () => {
    expect(resolveConsultCliLaunch({
      daemonEntry: '/repo/daemon.ts',
      runtime: '/opt/bun/bin/bun',
      exists: path => path === '/repo/src/consult-cli.ts',
    })).toEqual({ runtime: '/opt/bun/bin/bun', entry: '/repo/src/consult-cli.ts' })
    expect(resolveConsultCliLaunch({
      daemonEntry: '/pkg/dist/lodestar.js',
      runtime: '/usr/bin/node',
      exists: path => path === '/pkg/dist/lodestar-consult.js',
    })).toEqual({ runtime: '/usr/bin/node', entry: '/pkg/dist/lodestar-consult.js' })
    expect(() => resolveConsultCliLaunch({
      daemonEntry: '/missing/daemon.ts', runtime: '/opt/bun/bin/bun', exists: () => false,
    })).toThrow('entry not found')
  })

  test('atomically installs an executable wrapper and prepends its directory to PATH', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const target = ensureLodestarConsultCommand({
      platform: 'linux',
      targetDir,
      launch: { runtime: "/opt/bun's/bin/bun", entry: '/repo/src/consult-cli.ts' },
      env,
    })
    expect(readFileSync(target, 'utf8')).toContain(`exec '/opt/bun'"'"'s/bin/bun' '/repo/src/consult-cli.ts' "$@"`)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(env.PATH).toBe(`${targetDir}:/usr/bin`)
  })

  test('writes a Windows command wrapper and updates Path case-insensitively', () => {
    const targetDir = join(tempRoot(), 'bin')
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const target = ensureLodestarConsultCommand({
      platform: 'win32',
      targetDir,
      launch: { runtime: 'C:\\Bun\\bun.exe', entry: 'C:\\Lodestar\\consult.js' },
      env,
    })
    expect(target.endsWith('lodestar-consult.cmd')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('@"C:\\Bun\\bun.exe" "C:\\Lodestar\\consult.js" %*\r\n')
    expect(env.Path).toBe(`${targetDir};C:\\Windows`)
  })
})
