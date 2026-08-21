/**
 * CLI entry for `lodestar-update` bin.
 *
 * 跑全局 npm install，把 Lodestar、Codex CLI、Claude Code CLI 以及
 * Claude Agent SDK / Anthropic SDK 一起升。stdio inherit 让 npm 自己的
 * 进度条和版本号输出原样透出来。完事后提示用户重启 daemon —— 我们
 * 这里 *不* 主动 stop + start, 因为 daemon 可能挂在 systemd / Windows
 * 后台托管下,由那边接管,自重启会撞两次。让用户自己根据部署方式决定。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PID_FILE } from './paths'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
}

const UPDATE_PACKAGES = [
  '@leviyuan/lodestar@latest',
  '@openai/codex@latest',
  '@anthropic-ai/claude-code@latest',
  '@anthropic-ai/claude-agent-sdk@latest',
  '@anthropic-ai/sdk@latest',
] as const

function runNpmInstall(): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const child = spawn(
      npm,
      ['install', '-g', '--include=optional', ...UPDATE_PACKAGES],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    )
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (e) => {
      console.error(`${C.red}spawn npm 失败:${C.reset} ${e.message}`)
      resolve(1)
    })
  })
}

async function main(): Promise<void> {
  console.log(`${C.bold}更新 Lodestar + Codex CLI + Claude Code / SDK${C.reset}`)
  console.log(`${C.dim}npm i -g ${UPDATE_PACKAGES.join(' ')}${C.reset}\n`)

  const code = await runNpmInstall()
  if (code !== 0) {
    console.error(`\n${C.red}更新失败 (npm exit ${code})${C.reset}`)
    process.exit(code)
  }

  console.log(`\n${C.green}✓ 更新完成${C.reset}`)
  if (existsSync(PID_FILE)) {
    console.log()
    console.log(`${C.yellow}检测到 daemon 仍在跑老版本进程, 用新版本需要重启:${C.reset}`)
    console.log(`  ${C.dim}# Linux systemd --user 托管的:${C.reset}`)
    console.log(`  ${C.cyan}systemctl --user restart lodestar${C.reset}      ${C.dim}# Linux${C.reset}`)
    console.log(`  ${C.dim}# macOS launchd / Windows 任务计划:用对应服务管理器重启。${C.reset}`)
    console.log(`  ${C.dim}# 或手动重启:${C.reset}`)
    console.log(`  ${C.cyan}lodestar-stop && lodestar-daemon${C.reset}`)
  }
}

main().catch((e: any) => {
  console.error(`${C.red}lodestar-update:${C.reset} ${e?.message ?? e}`)
  process.exit(1)
})
