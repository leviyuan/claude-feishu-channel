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
 * command = 剥掉注释后的真正命令体。
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

/** 便捷封装:只想要 desc 说明(无则回退到命令首行截断)。 */
export function shellCommandDescription(raw: unknown, fallbackChars = 60): string {
  const { description, command } = shellCommandPresentation(raw)
  if (description) return description
  return command.replace(/\s+/g, ' ').trim().slice(0, fallbackChars)
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

function unwrapQuotedDescCommand(command: string): string {
  const s = command.trim()
  const quote = s[0]
  if (!QUOTE_CLOSER[quote]) return s
  const body = s.slice(1).replace(/\s*[”"]\s*$/, '')
  if (!/^#\s*(?:desc|dec|description|说明|目的|用途)\s*[:：]/i.test(body)) return s
  if (quote !== '"') return body
  return body
    .replace(/\\(["\\$`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\s*"\s*'\$\(([^)]*)\)'/g, (_m, inner) => ` $(${inner})`)
}
