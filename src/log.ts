import {
  appendFileSync, mkdirSync, readdirSync, unlinkSync,
  existsSync, statSync, renameSync, readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { LOG_FILE, DATA_DIR } from './paths'

/** 测试进程(bun test 固定设 NODE_ENV=test)禁止碰生产 DATA_DIR:
 * 不落盘、不迁移旧日志、不清理 —— 否则跑一遍测试就往真实
 * daemon-*.log 里塞 session "probe" 噪音,排障时被当成线上故障。 */
export function fileLoggingEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'test'
}

if (fileLoggingEnabled()) {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

/** 按日日志保留天数(含今天);超过即清理。 */
const LOG_RETENTION_DAYS = 7
const LOG_PREFIX = 'daemon-'
const LOG_SUFFIX = '.log'

/** 本地日期 → YYYY-MM-DD 文件名片段。用本地时区(用户看"今天的日志"
 * 按本地日历算),日志行内的时间戳仍是 UTC ISO(带 Z),两者互补。 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 某一天的日志文件绝对路径(默认 DATA_DIR)。 */
export function logFileForDate(d: Date, dir: string = DATA_DIR): string {
  return join(dir, `${LOG_PREFIX}${localDayKey(d)}${LOG_SUFFIX}`)
}

/** 从按日日志文件名解析其日期;非日志文件或格式不符返回 null。 */
export function parseLogFileDate(filename: string): Date | null {
  if (!filename.startsWith(LOG_PREFIX) || !filename.endsWith(LOG_SUFFIX)) return null
  const key = filename.slice(LOG_PREFIX.length, filename.length - LOG_SUFFIX.length)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** 删除超过 maxDays 的按日日志文件,返回删除数。未来文件(ageDays<0)
 * 与非日志文件不动。 */
export function pruneOldLogs(
  dir: string,
  now: Date = new Date(),
  maxDays: number = LOG_RETENTION_DAYS,
): number {
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let removed = 0
  for (const name of names) {
    const fileDate = parseLogFileDate(name)
    if (!fileDate) continue
    const ageDays = Math.round((todayMidnight.getTime() - fileDate.getTime()) / 86_400_000)
    if (ageDays < maxDays) continue
    try { unlinkSync(join(dir, name)); removed++ } catch {}
  }
  return removed
}

/** 一次性迁移:老的 append-only daemon.log(无日期后缀)rename 成按其
 * mtime 日期命名的按日文件,纳入 7 天保留管辖。同分区 rename 原子且 O(1)。
 * 若当天按日文件已存在(迁移中途崩溃重启的罕见情况),内容追加合并后删源。 */
function migrateLegacyLogFile(): void {
  try {
    if (!existsSync(LOG_FILE)) return
    const st = statSync(LOG_FILE)
    if (!st.isFile() || st.size === 0) return
    const target = logFileForDate(st.mtime)
    if (existsSync(target)) {
      appendFileSync(target, readFileSync(LOG_FILE))
      unlinkSync(LOG_FILE)
      return
    }
    renameSync(LOG_FILE, target)
  } catch {}
}

let lastDayKey: string | null = null

/** 追加一行到今天的按日日志,同时打到 stderr。跨天(含进程启动后首次
 * 写入)顺带清理超过 7 天的旧日志。 */
export function log(msg: string): void {
  const now = new Date()
  const line = `[${now.toISOString()}] ${msg}\n`
  process.stderr.write(line)
  if (!fileLoggingEnabled()) return
  try {
    const key = localDayKey(now)
    if (lastDayKey !== key) {
      lastDayKey = key
      pruneOldLogs(DATA_DIR, now)
    }
    appendFileSync(logFileForDate(now), line)
  } catch {}
}

// 启动:先把老 daemon.log 迁移成按日文件,再清理过期日志。
if (fileLoggingEnabled()) {
  migrateLegacyLogFile()
  try { pruneOldLogs(DATA_DIR) } catch {}
}
