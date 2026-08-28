import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { ConsultTarget } from './consult-types'

const MAX_CONTEXT_CHARS = 500_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const execFileAsync = promisify(execFile)

export interface ConsultTargetContext {
  target: ConsultTarget
  fingerprint: string
  promptContext: string
}

export async function buildConsultTargetContext(
  workDir: string,
  target: ConsultTarget,
): Promise<ConsultTargetContext> {
  if (!isAbsolute(workDir)) throw new Error(`consult cwd is not absolute: ${workDir}`)
  if (!existsSync(workDir) || !statSync(workDir).isDirectory()) throw new Error(`consult cwd is not a directory: ${workDir}`)
  let promptContext: string
  switch (target.type) {
    case 'working_directory': {
      const git = await tryGitSnapshot(workDir)
      promptContext = [
        `工作目录: ${workDir}`,
        git.snapshot ? `Git 快照:\n${git.snapshot}` : `Git 快照 MISS: ${git.error}`,
        '按需读取项目文件，不得修改。',
      ].join('\n\n')
      break
    }
    case 'uncommitted_changes': {
      const status = await git(workDir, ['status', '--short', '--untracked-files=all'])
      const diff = await git(workDir, ['diff', '--no-ext-diff', 'HEAD', '--'])
      promptContext = [
        `工作目录: ${workDir}`,
        '评审目标: 当前未提交变更。',
        `git status --short:\n${status || '(clean)'}`,
        `git diff HEAD --:\n${diff || '(empty diff)'}`,
        '未跟踪文件不会出现在 diff 正文中；如需证据，根据 status 列表以只读方式检查。',
      ].join('\n\n')
      break
    }
    case 'commit': {
      assertGitRef(target.sha)
      const commit = (await git(workDir, ['rev-parse', '--verify', `${target.sha}^{commit}`])).trim()
      const diff = await git(workDir, ['show', '--no-ext-diff', '--format=fuller', '--stat', '--patch', commit, '--'])
      promptContext = `工作目录: ${workDir}\n\n评审 commit: ${commit}\n\n${diff}`
      break
    }
    case 'base_branch': {
      assertGitRef(target.branch)
      const base = (await git(workDir, ['rev-parse', '--verify', `${target.branch}^{commit}`])).trim()
      const head = (await git(workDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
      const diff = await git(workDir, ['diff', '--no-ext-diff', '--stat', '--patch', `${base}...${head}`, '--'])
      promptContext = `工作目录: ${workDir}\n\n评审范围: ${target.branch}(${base})...HEAD(${head})\n\n${diff}`
      break
    }
    case 'proposal':
      promptContext = `项目工作目录: ${workDir}\n\n待评审文本:\n${target.text}`
      break
  }
  if (promptContext.length > MAX_CONTEXT_CHARS) {
    throw new Error(`consult target context is too large (${promptContext.length}/${MAX_CONTEXT_CHARS} chars)`)
  }
  return {
    target,
    promptContext,
    fingerprint: createHash('sha256').update(promptContext).digest('hex'),
  }
}

async function tryGitSnapshot(cwd: string): Promise<{ snapshot: string | null; error: string | null }> {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const status = await git(cwd, ['status', '--short', '--untracked-files=all'])
    return { snapshot: [`root=${top}`, `HEAD=${head}`, status || 'clean'].join('\n'), error: null }
  } catch (error) {
    return { snapshot: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function assertGitRef(value: string): void {
  if (!value || value.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error(`invalid git ref: ${JSON.stringify(value)}`)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return String(stdout)
  } catch (error) {
    const value = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const stderr = Buffer.isBuffer(value.stderr) ? value.stderr.toString('utf8') : String(value.stderr ?? '')
    const stdout = Buffer.isBuffer(value.stdout) ? value.stdout.toString('utf8') : String(value.stdout ?? '')
    throw new Error([
      `git ${args.join(' ')} failed`,
      value.message,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join(': '))
  }
}
