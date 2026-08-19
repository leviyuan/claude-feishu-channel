/**
 * Shell 命令展示解析 —— 所有把命令渲染给用户的 surface 共用的唯一入口。
 *
 * 背景: 各后端把命令以不同包装送达 ——
 *   - Claude/macOS/Linux: 裸命令,首行 `# desc: <中文说明>` 注释(见
 *     instructions.ts 的约定);
 *   - Codex 统一 exec: 外面包一层引号 `"# desc: ...\ngit status"`;
 *   - Codex Windows: 外面包一层 PowerShell 调用,引号风格随内容漂移:
 *       "C:\...\powershell.exe" -Command "# desc: ...\nGet-Content ..."
 *       'C:\...\powershell.exe' -Command '# desc: ...\nGet-ChildItem ...'
 *
 * 三个渲染面(主卡工具面板 cards/tool.ts、后台卡 steps cards/background.ts、
 * Codex 子 agent 简报 codex-process.ts)都必须经由这里的 presentationOf
 * 取「目的 + 命令体」,不允许各自裸拼 —— 否则 Windows 上一处修了另一处还丑。
 */

/** 参数外层引号种类(含全角,模型输出里见过)。 */
const QUOTE_CLOSER: Record<string, string> = { '"': '"', "'": "'", '“': '”' }

export function stripQuotes(arg: string): string {
  const s = arg.trim()
  if (s.length < 2) return s
  const end = QUOTE_CLOSER[s[0]]
  if (!end || !s.endsWith(end)) return s
  const body = s.slice(1, -1)
  // PowerShell 语义: 单引号串里 '' 转义 ';双引号串里 \" 转义 "。
  if (s[0] === "'") return body.replace(/''/g, "'")
  if (s[0] === '"') return body.replace(/\\"/g, '"')
  return body
}

/**
 * 命令的展示拆分:description = desc 注释里的中文说明(无则空),
 * command = 剥掉注释后的真正命令体(平台包装已剥,无 desc 时也剥干净引号)。
 */
export function shellCommandPresentation(raw: unknown): { description: string; command: string } {
  const rawCommand = unwrapShellCommand(String(raw ?? ''))
  const firstLine = rawCommand.split('\n', 1)[0]?.trim() ?? ''
  const comment = firstLine.startsWith('#') && !firstLine.startsWith('#!')
    ? firstLine.replace(/^#\s*/, '').trim()
    : ''
  const commentDesc = comment.replace(/^(?:desc|dec|description|说明|目的|用途)\s*[:：]\s*/i, '').trim()
  const command = commentDesc
    ? rawCommand.split('\n').slice(1).join('\n').trimStart()
    : rawCommand
  return { description: commentDesc, command: command || rawCommand }
}

/**
 * 便捷封装:只想要一句单行说明(后台卡 steps / 子 agent 简报用)。
 * 无 desc 时回退到首个有意义的命令行截断 —— 与主卡 header 的回退同构,
 * 各平台(mac 裸命令 / Codex exec 引号 / Windows PowerShell)格式一致。
 */
export function shellCommandDescription(raw: unknown, fallbackChars = 60): string {
  const { description, command } = shellCommandPresentation(raw)
  if (description) return description
  const firstMeaningful = firstMeaningfulCommandLine(command)
  return firstMeaningful.replace(/\s+/g, ' ').trim().slice(0, fallbackChars)
}

/**
 * 无 desc 时的摘要行:跳过 set -e / cd / 环境变量赋值 / heredoc 起手这类
 * 前置行,取第一行真正干活的命令;全是前置行时取最后一行(脚本的目的
 * 行,而不是回头显示 set -e)。
 */
function firstMeaningfulCommandLine(command: string): string {
  const lines = command.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.find(line =>
    !line.startsWith('#') &&
    !/^set\s+-/.test(line) &&
    !/^cd\s+/.test(line) &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line) &&
    !/^cat\s+<<['"]?\w+['"]?/.test(line)
  ) ?? lines[lines.length - 1] ?? ''
}

function unwrapShellCommand(command: string): string {
  const normalized = command.replace(/\r\n/g, '\n').trim()
  const shell = normalized.match(/^(?:\/usr\/bin\/env\s+)?(?:\/[\w./-]+\/)?(?:ba|z|fi)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/)
  if (shell) {
    const inner = stripShellArgQuotes(shell[1])
    return unwrapQuotedDescCommand(inner || normalized)
  }
  const powerShell = unwrapPowerShellCommand(normalized)
  if (powerShell) return powerShell
  return unwrapQuotedDescCommand(normalized)
}

/** PowerShell 双引号串内的转义语义(`` ` `` 与 `"`),路径反斜杠不是转义符。 */
function unwrapPowerShellCommand(command: string): string | null {
  const head = command.match(/^("[^"]*"|'[^']*'|“[^”]*”|\S+)\s+([\s\S]*)$/)
  if (!head) return null
  const exe = stripQuotes(head[1]).replace(/\.exe$/i, '')
  if (!/(?:^|[\\/])(?:powershell|pwsh)$/i.test(exe)) return null
  let rest = head[2]
  for (;;) {
    const flag = rest.match(/^(-[A-Za-z][\w-]*)\s+([\s\S]*)$/)
    if (!flag) break
    const name = flag[1].toLowerCase()
    if (name === '-command' || name === '-c') return unwrapQuotedDescCommand(stripQuotes(flag[2]))
    rest = flag[2]
    if (name === '-executionpolicy' || name === '-inputformat' || name === '-outputformat') {
      rest = rest.replace(/^(?:"[^"]*"|'[^']*'|\S+)\s+/, '')
    }
  }
  return null
}

function stripShellArgQuotes(arg: string): string {
  const s = arg.trim()
  if (s.length < 2) return s
  const close = QUOTE_CLOSER[s[0]]
  if (!close || !s.endsWith(close)) return s
  const body = s.slice(1, -1)
  if (s[0] === "'") return body.replace(/'\\''/g, "'")
  return body.replace(/\\(["\\$`])/g, '$1').replace(/\\n/g, '\n')
}

/** 剥掉整条命令最外层的引号包装(Codex 统一 exec 形态)。
 *  有 desc 注释时必须剥 —— 注释与命令体都在引号里;无 desc 时,只有当
 *  整串就是一对引号(第一个字符是开引号、最后一个字符是配对闭引号、
 *  中间的闭引号都被转义或成对出现在内部)才剥 —— 区分「包装」与「命令
 *  自身的引号参数」(grep "x" file / "a" "b" 不能当包装剥)。 */
function unwrapQuotedDescCommand(command: string): string {
  const s = command.trim()
  const quote = s[0]
  if (!QUOTE_CLOSER[quote]) return s
  const body = s.slice(1)
  const hasDesc = /^#\s*(?:desc|dec|description|说明|目的|用途)\s*[:：]/i.test(body)
  if (!hasDesc && !isSingleQuotedWrap(body, quote)) return s
  if (quote !== '"') {
    // 单引号串:去掉尾部闭引号即可(内部无转义语义)。
    return body.replace(/'\s*$/, '')
  }
  // 双引号串:desc 场景尾部可能带有多余闭引号/全角引号,一并清掉;
  // 之后还原 \" → "、\n → 换行、"'$(cmd)'" → "$(cmd)"(Codex exec 的
  // $() 引号逃逸形态)。
  const inner = body
    .replace(/\s*[”"]\s*$/, '')
    .replace(/\\(["\\$`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\s*"\s*'\$\(([^)]*)\)'/g, (_m, g1) => ` $(${g1})`)
  return inner
}

/** 整串恰好是一对引号包住的内容(可当包装剥):从 body 头开始扫描,
 *  转义(\")跳过,遇到非转义闭引号时 —— 它必须是最后一个非空白字符,
 *  否则后面还有裸 token,说明引号只是首个参数("a b" "c d" / grep "x" f)。 */
function isSingleQuotedWrap(body: string, quote: string): boolean {
  const closer = QUOTE_CLOSER[quote]
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote === '"' && ch === '\\' && i + 1 < body.length) { i++; continue }
    if (ch === closer) {
      return /^[\s]*$/.test(body.slice(i + 1))
    }
  }
  return false
}
