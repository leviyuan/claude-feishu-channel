import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

function ensureParent(filePath: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
}

/**
 * Replace a state file atomically.
 *
 * Direct writeFileSync(path, ...) truncates the live file before writing; a
 * crash or full disk can therefore destroy the previous valid snapshot. This
 * helper writes and fsyncs a sibling temporary file, renames it over the live
 * path, then best-effort fsyncs the directory entry.
 */
export function writeStateFileAtomic(filePath: string, content: string | Uint8Array): void {
  ensureParent(filePath)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'wx', PRIVATE_FILE_MODE)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tempPath, filePath)
    try { chmodSync(filePath, PRIVATE_FILE_MODE) } catch {}

    if (process.platform !== 'win32') {
      let dirFd: number | null = null
      try {
        dirFd = openSync(dirname(filePath), 'r')
        fsyncSync(dirFd)
      } catch {
        // Some filesystems do not support directory fsync. The file itself
        // has already been fsynced and atomically renamed, so this is a
        // durability enhancement rather than a reason to report a false
        // transition failure after commit.
      } finally {
        if (dirFd !== null) {
          try { closeSync(dirFd) } catch {}
        }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(tempPath) } catch {}
    throw error
  }
}

export function writeJsonStateAtomic(filePath: string, value: unknown): void {
  writeStateFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n')
}
