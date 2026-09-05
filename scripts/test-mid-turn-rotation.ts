#!/usr/bin/env bun
/**
 * 在已 seed 的目标群复现中途来消息时的换卡：先 kill 会话，再发送慢任务和打断消息。
 * bun scripts/test-mid-turn-rotation.ts <chat_id>
 *
 * 使用现有 daemon 的 debug socket，不创建 Session。运行后输出本次日志供人工核对。
 */
import { readFileSync } from 'node:fs'
import { DEBUG_CTX_FILE } from '../src/paths'
import { logFileForDate } from '../src/log'
import { injectDebugMessage } from './debug-client'

async function main(): Promise<void> {
  const chatId = process.argv[2]
  if (!chatId) throw new Error('usage: bun scripts/test-mid-turn-rotation.ts <chat_id>')
  const inject = async (text: string) => {
    const context = JSON.parse(readFileSync(DEBUG_CTX_FILE, 'utf8'))
    if (context.chat_id !== chatId) throw new Error('debug context does not match the requested chat_id; seed the target group first')
    return await injectDebugMessage(text)
  }
  const startedAt = new Date()
  const logFile = logFileForDate(startedAt)
  const logOffset = readFileSync(logFile).length

  console.log(`sending kill to ${chatId}`)
  await inject('kill')
  await Bun.sleep(3000)
  await inject('你好。请慢慢从1数到20，每个数字单独一行回复，每数字之间停顿1秒')
  await Bun.sleep(8000)
  await inject('停下，告诉我你数到几了')
  await Bun.sleep(45000)

  const endLogFile = logFileForDate(new Date())
  let excerpt = readFileSync(logFile).subarray(logOffset).toString('utf8')
  if (endLogFile !== logFile) excerpt += readFileSync(endLogFile, 'utf8')
  for (const line of excerpt.split('\n')) {
    if (/debug:|SDK init|SDK result|openTurnCard|drainMidTurn|cardkit/.test(line)) console.log(line)
  }
  console.log('消息注入完成；请核对群内旧卡换卡提示、新卡和最终状态。')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
