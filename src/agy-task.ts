import { type ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'cross-spawn'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export const AGY_DEFAULT_MODEL = 'Gemini 3.1 Pro (High)'
export const AGY_PRINT_TIMEOUT = '180m0s'
export const AGY_HOST_TIMEOUT_MS = 181 * 60 * 1000

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface GitSnapshot {
  ok: boolean
  statusShort: string
  diffShortStat: string
  diffNameOnly: string
  error?: string
}

export type AgyProcess = ChildProcessByStdio<Writable, Readable, Readable>

export function resolveAgyBin(): string {
  if (process.platform !== 'win32') {
    const local = join(homedir(), '.local', 'bin', 'agy')
    if (existsSync(local)) return local
  }
  return whichAgy() ?? 'agy'
}

export function buildAgySpawnPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  return [...new Set([
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.local', 'npm-global', 'bin'),
    join(homedir(), '.bun', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].filter(Boolean))].join(delimiter)
}

export function agyPrintArgs(prompt: string): string[] {
  return [
    '--model', AGY_DEFAULT_MODEL,
    '--dangerously-skip-permissions',
    '--print-timeout', AGY_PRINT_TIMEOUT,
    '-p', prompt,
  ]
}

export function agyDisplayCommand(): string {
  return `agy --model "${AGY_DEFAULT_MODEL}" --dangerously-skip-permissions --print-timeout ${AGY_PRINT_TIMEOUT} -p <prompt>`
}

export function spawnAgyPrint(prompt: string, cwd: string): { proc: AgyProcess; bin: string; args: string[] } {
  const bin = resolveAgyBin()
  const args = agyPrintArgs(prompt)
  const proc = spawn(bin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...(process.env as Record<string, string>),
      PATH: buildAgySpawnPath(),
    },
  }) as unknown as AgyProcess
  return { proc, bin, args }
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const status = await runGit(cwd, ['status', '--short', '--untracked-files=all'])
  if (!status.ok) {
    return {
      ok: false,
      statusShort: status.stdout,
      diffShortStat: '',
      diffNameOnly: '',
      error: (status.error ?? status.stderr.trim()) || 'git status failed',
    }
  }

  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])).ok
  const diffBase = hasHead ? ['HEAD', '--'] : ['--']
  const shortStat = await runGit(cwd, ['diff', '--shortstat', ...diffBase])
  const nameOnly = await runGit(cwd, ['diff', '--name-only', ...diffBase])
  const errors = [shortStat, nameOnly]
    .filter(r => !r.ok)
    .map(r => r.error ?? r.stderr.trim())
    .filter(Boolean)

  return {
    ok: errors.length === 0,
    statusShort: status.stdout.trimEnd(),
    diffShortStat: shortStat.stdout.trim(),
    diffNameOnly: nameOnly.stdout.trimEnd(),
    ...(errors.length ? { error: errors.join('\n') } : {}),
  }
}

function whichAgy(): string | null {
  const PATH = process.env.PATH ?? ''
  if (!PATH) return null
  const candidates = process.platform === 'win32'
    ? ['agy.cmd', 'agy.bat', 'agy.exe', 'agy']
    : ['agy']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const name of candidates) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...(process.env as Record<string, string>),
        PATH: buildAgySpawnPath(),
      },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGTERM')
      resolve({ ok: false, stdout, stderr, error: `git ${args.join(' ')} timed out after 10s` })
    }, 10_000)

    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => { stderr += chunk.toString() })
    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, error: err.message })
    })
    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ok = code === 0
      resolve({
        ok,
        stdout,
        stderr,
        ...(ok ? {} : { error: `git ${args.join(' ')} exited ${code}` }),
      })
    })
  })
}
