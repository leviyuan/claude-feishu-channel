import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export const AI_AUTO_BRANCH = 'AI-AUTO'
export const AI_REVIEW_BRANCH = 'AI-REVIEW'

export function prepareAutomationWorktree(
  projectDir: string,
  projectName: string,
  branch: string,
  expectedBaseHead?: string,
): string {
  assertGitRepo(projectDir)
  const targetPath = join(dirname(projectDir), `${projectName}[${branch}]`)
  const actualBaseHead = git(projectDir, ['rev-parse', 'HEAD']).trim()
  if (expectedBaseHead && actualBaseHead !== expectedBaseHead) {
    throw new Error(`project HEAD changed before worktree prepare: expected ${expectedBaseHead}, got ${actualBaseHead}`)
  }
  const baseHead = expectedBaseHead ?? actualBaseHead
  const mounted = parseWorktreeList(projectDir).get(branch) ?? null
  if (!hasBranch(projectDir, branch)) git(projectDir, ['branch', branch, 'HEAD'])
  if (mounted) {
    if (resolve(mounted) !== resolve(targetPath)) {
      throw new Error(`${branch} is already mounted at ${mounted}`)
    }
  } else {
    git(projectDir, ['worktree', 'add', targetPath, branch])
  }
  assertWorktreeBranch(targetPath, branch)
  assertCleanWorktree(targetPath)
  const unique = Number(git(targetPath, ['rev-list', '--count', `${baseHead}..HEAD`]).trim() || '0')
  if (unique > 0) {
    throw new Error(`${branch} has ${unique} commit(s) not reachable from project HEAD; merge or reset it before next automation run`)
  }
  git(targetPath, ['reset', '--hard', baseHead])
  return targetPath
}

function assertGitRepo(projectDir: string): void {
  const top = git(projectDir, ['rev-parse', '--show-toplevel']).trim()
  if (resolve(top) !== resolve(projectDir)) {
    throw new Error(`${projectDir} is not the git repository root (${top})`)
  }
}

function assertWorktreeBranch(worktreePath: string, branch: string): void {
  const actual = git(worktreePath, ['branch', '--show-current']).trim()
  if (actual !== branch) throw new Error(`${worktreePath} is on ${actual}, expected ${branch}`)
}

function assertCleanWorktree(worktreePath: string): void {
  const dirty = git(worktreePath, ['status', '--porcelain=v1']).split('\n').filter(Boolean)
  if (dirty.length > 0) throw new Error(`worktree has uncommitted changes:\n${dirty.slice(0, 8).join('\n')}`)
}

function hasBranch(projectDir: string, branch: string): boolean {
  try {
    git(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function parseWorktreeList(projectDir: string): Map<string, string> {
  const out = new Map<string, string>()
  let currentPath = ''
  for (const line of git(projectDir, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length)
    if (line.startsWith('branch refs/heads/') && currentPath) out.set(line.slice('branch refs/heads/'.length), currentPath)
  }
  return out
}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(errorOutput(e))
  }
}

export function localReviewRef(baseBranch: string, headBranch: string): string {
  const base = baseBranch.trim()
  const head = headBranch.trim()
  if (!base) throw new Error('base branch is required for local review ref')
  if (!head) throw new Error('head branch is required for local review ref')
  return `local:${base}..${head}`
}

export function taskArtifactTag(taskGuid: string): string {
  const guid = taskGuid.trim()
  if (!guid) throw new Error('task guid is required for task artifact tag')
  return `${AI_AUTO_BRANCH}/${guid}`
}

export function reviewDiffSpec(reviewRequest: string): string {
  const raw = reviewRequest.trim()
  if (!raw.startsWith('local:')) throw new Error(`unsupported local review request: ${reviewRequest}`)
  const diffSpec = raw.slice('local:'.length).trim()
  if (!diffSpec.includes('..')) throw new Error(`unsupported local review diff: ${reviewRequest}`)
  return diffSpec
}

export function reviewHeadRef(reviewRequest: string): string {
  const diffSpec = reviewDiffSpec(reviewRequest)
  const index = diffSpec.lastIndexOf('..')
  const head = diffSpec.slice(index + 2).trim()
  if (!head) throw new Error(`missing review head ref: ${reviewRequest}`)
  return head
}

export function assertTaskArtifactTagAvailable(cwd: string, tag: string): void {
  try {
    git(cwd, ['check-ref-format', `refs/tags/${tag}`])
  } catch {
    throw new Error(`invalid task artifact tag: ${tag}`)
  }
  if (gitRefExists(cwd, `refs/tags/${tag}`)) {
    throw new Error(`task artifact tag already exists: ${tag}`)
  }
}

export function createTaskArtifactTag(cwd: string, tag: string, commitHash: string): void {
  assertTaskArtifactTagAvailable(cwd, tag)
  git(cwd, ['tag', tag, commitHash])
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

export function isReviewHeadMerged(cwd: string, reviewRequest: string): { ok: true } | { ok: false; error: string } {
  let headRef: string
  try {
    headRef = reviewHeadRef(reviewRequest)
  } catch (e) {
    return { ok: false, error: messageOf(e) }
  }
  try {
    git(cwd, ['merge-base', '--is-ancestor', headRef, 'HEAD'])
    return { ok: true }
  } catch {
    return { ok: false, error: `${headRef} is not an ancestor of HEAD` }
  }
}


function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function errorOutput(e: unknown): string {
  const any = e as any
  const stderr = Buffer.isBuffer(any?.stderr) ? any.stderr.toString('utf8') : String(any?.stderr ?? '')
  const stdout = Buffer.isBuffer(any?.stdout) ? any.stdout.toString('utf8') : String(any?.stdout ?? '')
  const message = e instanceof Error ? e.message : String(e)
  return [message, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
}
