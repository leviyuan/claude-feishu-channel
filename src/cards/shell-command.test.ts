import { describe, expect, test } from 'bun:test'
import { shellCommandPresentation, shellCommandDescription } from './shell-command'

const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH_EXE = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

describe('shellCommandPresentation — desc 注释提取', () => {
  test('裸命令 + desc 注释(_unix 主路径)', () => {
    const { description, command } = shellCommandPresentation('# desc: 查看工作区状态\ngit status --short')
    expect(description).toBe('查看工作区状态')
    expect(command).toBe('git status --short')
  })

  test('无注释的裸命令原样保留', () => {
    const { description, command } = shellCommandPresentation('ls -la')
    expect(description).toBe('')
    expect(command).toBe('ls -la')
  })

  test('desc 变体:dec / description / 说明 / 目的 / 用途 / 全角冒号', () => {
    for (const prefix of ['desc', 'dec', 'description', '说明', '目的', '用途']) {
      const { description } = shellCommandPresentation(`# ${prefix}: 干活\ntrue`)
      expect(description).toBe('干活')
      const { description: d2 } = shellCommandPresentation(`# ${prefix}：干活\ntrue`)
      expect(d2).toBe('干活')
    }
  })

  test('shebang 不是 desc 注释', () => {
    const { description, command } = shellCommandPresentation('#!/bin/bash\necho hi')
    expect(description).toBe('')
    expect(command).toBe('#!/bin/bash\necho hi')
  })

  test('普通注释(非 desc 前缀)沿用旧语义:注释本身作为说明', () => {
    // 旧 bashPresentation 即如此:首行任何 # 注释都当说明,desc 前缀只是可选修饰。
    const { description, command } = shellCommandPresentation('# 只是注释\necho hi')
    expect(description).toBe('只是注释')
    expect(command).toBe('echo hi')
  })
})

describe('shellCommandPresentation — 包装剥离', () => {
  test('sh -c / bash -lc 包装(unix)', () => {
    const { description, command } = shellCommandPresentation('/bin/bash -lc "# desc: 拉取远端\ngit fetch --all"')
    expect(description).toBe('拉取远端')
    expect(command).toBe('git fetch --all')
  })

  test('Codex 统一 exec 双引号包装 + $() 引号还原', () => {
    const raw = '"# desc: 搜索旧关键词\nrg -n -i \\"legacy|deprecated|old\\" "\'$(git ls-files)\''
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('搜索旧关键词')
    expect(command).toBe('rg -n -i "legacy|deprecated|old" $(git ls-files)')
  })

  test('PowerShell 双引号包装(exe 与命令体都是双引号)', () => {
    const raw = `"${PS_EXE}" -Command "# desc: 读取技能说明\nGet-Content -LiteralPath 'C:\\Users\\u\\.codex\\SKILL.md' -Raw"`
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('读取技能说明')
    expect(command).toBe("Get-Content -LiteralPath 'C:\\Users\\u\\.codex\\SKILL.md' -Raw")
  })

  test('PowerShell 单引号包装(exe 与命令体都是单引号)—— 用户 2026-08-19 实测样本风格', () => {
    const raw = `'${PS_EXE}' -Command '# desc: 查看 xyq 项目里的鼠标模板、任务和当前数据目录状态\nGet-ChildItem "C:\\Users\\u\\xyq" -Recurse'`
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('查看 xyq 项目里的鼠标模板、任务和当前数据目录状态')
    expect(command).toBe('Get-ChildItem "C:\\Users\\u\\xyq" -Recurse')
  })

  test('pwsh + 旗标(-NoProfile -ExecutionPolicy Bypass)', () => {
    const raw = `"${PWSH_EXE}" -NoProfile -ExecutionPolicy Bypass -Command "# desc: 拉取远端最新提交\ngit fetch --all --prune"`
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('拉取远端最新提交')
    expect(command).toBe('git fetch --all --prune')
  })

  test('不带引号的 powershell.exe / pwsh', () => {
    for (const exe of ['powershell.exe', 'powershell', 'pwsh']) {
      const { description } = shellCommandPresentation(`${exe} -Command "# desc: 查看端口\nnetstat -ano"`)
      expect(description).toBe('查看端口')
    }
  })

  test('正斜杠路径的 powershell(交叉 shell 场景)', () => {
    const { description } = shellCommandPresentation('/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "# desc: 看目录\nls"')
    expect(description).toBe('看目录')
  })

  test('单引号串内连续两个单引号转义还原为单个引号', () => {
    const raw = `powershell -Command '# desc: 查日志\nSelect-String -Pattern ''error'' -Path C:\\x.log'`
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('查日志')
    expect(command).toBe("Select-String -Pattern 'error' -Path C:\\x.log")
  })

  test('PowerShell 包装但无 desc 注释:命令体原样保留', () => {
    const raw = `"${PS_EXE}" -Command "Get-Date"`
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('')
    expect(command).toBe('Get-Date')
  })

  test('非 PowerShell 可执行不误剥', () => {
    const raw = '"C:\\Tools\\mysh.exe" -Command "# desc: x\ntrue"'
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('')
    expect(command).toBe(raw)
  })

  test('CRLF 换行归一', () => {
    const raw = `"${PS_EXE}" -Command "# desc: 查状态\r\ngit status"`.replace(/\\r\\n/g, '\r\n')
    const { description, command } = shellCommandPresentation(raw)
    expect(description).toBe('查状态')
    expect(command).toBe('git status')
  })

  test('Codex exec 引号包装但无 desc:整条被包时也剥引号(mac 回退摘要不带引号)', () => {
    const { description, command } = shellCommandPresentation('"ls -la"')
    expect(description).toBe('')
    expect(command).toBe('ls -la')
  })

  test('非整条被包的引号(命令自身参数)不剥', () => {
    // grep 的参数引号不是包装;"a b" "c d" 两个引号参数同样不是包装。
    expect(shellCommandPresentation('grep "pattern" file.txt').command).toBe('grep "pattern" file.txt')
    expect(shellCommandPresentation('"a b" "c d"').command).toBe('"a b" "c d"')
  })

  test('多行脚本无 desc:跳过 set -e / cd / heredoc 起手取首条有效命令', () => {
    // FOO=1 bun test 也是被 env-prefix 过滤的行,且是最后一行 → 回退取尾行。
    expect(shellCommandDescription('set -e\ncd /app\nFOO=1 bun test')).toBe('FOO=1 bun test')
    // 有非前置行时取首条有效命令。
    expect(shellCommandDescription('set -e\ncd /app\nbun install\nbun test')).toBe('bun install')
  })
})

describe('shellCommandDescription — 后台卡 steps 简报用', () => {
  test('有 desc 显示 desc', () => {
    expect(shellCommandDescription(`"${PS_EXE}" -Command '# desc: 跑测试\nbun test'`)).toBe('跑测试')
  })

  test('无 desc 回退命令首行截断(不再显示 powershell.exe 路径)', () => {
    const desc = shellCommandDescription(`"${PS_EXE}" -Command "Get-ChildItem C:\\Users -Recurse -Filter *.log"`)
    expect(desc).toBe('Get-ChildItem C:\\Users -Recurse -Filter *.log')
    expect(desc).not.toContain('powershell')
  })

  test('空命令与空串', () => {
    expect(shellCommandDescription('')).toBe('')
    expect(shellCommandDescription(undefined)).toBe('')
  })
})
