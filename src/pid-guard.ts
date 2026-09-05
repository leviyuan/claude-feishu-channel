/**
 * PID 文件同时保存进程号和入口路径，检查时对照实际命令行，避免 PID 回收误判。
 * Linux 读 /proc，macOS 用 ps，Windows 用 Get-CimInstance Win32_Process。
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** 我们这个进程的唯一标记 = 入口脚本的绝对路径 (argv[1])。 */
export function ourMarker(): string {
  return process.argv[1] ?? `pid:${process.pid}`
}

function getCmdline(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    }
    if (process.platform === 'darwin') {
      return execSync(`ps -p ${pid} -o args=`, { encoding: 'utf8', timeout: 2000 }).trim()
    }
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: 'utf8', timeout: 5000 },
      ).trim()
      return out || null
    }
    return null
  } catch {
    return null
  }
}

/** 给定 pid 上是不是真的我们这个 daemon (而非 PID 回收 / 巧合同号)。 */
export function isOurDaemon(pid: number, marker: string): boolean {
  if (!Number.isFinite(pid) || pid <= 0 || !marker) return false
  const cmd = getCmdline(pid)
  if (!cmd) return false
  // Windows 路径大小写飘忽 (`C:\Users` vs `C:\users`), 不区分大小写匹配。
  if (process.platform === 'win32') {
    return cmd.toLowerCase().includes(marker.toLowerCase())
  }
  return cmd.includes(marker)
}

/** 读 PID 文件 → 看那个 pid 是不是真的我们 → 给调用方一个状态。
 *   continue → 没有合法 daemon, 启动新的 (调用方负责清 stale 文件 + 写新 PID)
 *   exit     → 真有 daemon 在跑, 调用方应该自己 exit */
export function checkPidGuard(pidFile: string): { state: 'continue' } | { state: 'exit'; pid: number } {
  let raw = ''
  try { raw = readFileSync(pidFile, 'utf8') } catch { return { state: 'continue' } }
  const lines = raw.split('\n')
  const pid = parseInt((lines[0] ?? '').trim(), 10)
  const savedMarker = (lines[1] ?? '').trim()
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'continue' }

  if (!savedMarker) {
    // 老格式 (只有一行 pid, 无 marker) —— 之前版本的 daemon 留下来的。
    // 退回老的 kill(pid, 0) 单点探活, 这次启动后会被覆盖成新格式。
    try {
      process.kill(pid, 0)
      return { state: 'exit', pid }
    } catch {
      return { state: 'continue' }
    }
  }

  if (isOurDaemon(pid, savedMarker)) return { state: 'exit', pid }
  return { state: 'continue' }
}

/** 写 PID 文件: 第一行 pid, 第二行 marker (argv[1] 绝对路径)。 */
export function writePidFile(pidFile: string): void {
  writeFileSync(pidFile, `${process.pid}\n${ourMarker()}`)
}
