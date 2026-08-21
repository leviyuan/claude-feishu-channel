import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonStateAtomic, writeStateFileAtomic } from './state-store'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function target(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-state-'))
  roots.push(root)
  return join(root, 'nested', name)
}

describe('atomic state store', () => {
  test('replaces a state snapshot without leaving sibling temp files', () => {
    const file = target('state.json')
    writeJsonStateAtomic(file, { version: 1 })
    writeJsonStateAtomic(file, { version: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2 })
    expect(readdirSync(join(file, '..'))).toEqual(['state.json'])
  })

  test('creates private state files on unix', () => {
    const file = target('state.txt')
    writeStateFileAtomic(file, 'ok\n')
    expect(readFileSync(file, 'utf8')).toBe('ok\n')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
