#!/usr/bin/env bun
/**
 * 对真实飞书群运行一轮 Session，使用该群保存的账号和模型。
 * bun scripts/smoke.ts <chat_name|chat_id> [prompt]
 * 目标群的 daemon 必须已停止；脚本不监听 WS，无法回答交互提问。
 */
const target = process.argv[2]
if (!target) {
  console.error('usage: bun scripts/smoke.ts <chat_name|chat_id> [prompt]')
  process.exit(1)
}

const { createSmokeSession, waitForSmokeIdle } = await import('./smoke-session')
const feishu = await import('../src/feishu')
const session = await createSmokeSession(target)
const prompt = process.argv.slice(3).join(' ').trim() || '你好，简单介绍一下你自己，用三句话。'
try {
  const messageId = await feishu.sendText(session.chatId, `🧪 [SMOKE] 模拟用户输入：\n> ${prompt}`)
  if (!messageId) throw new Error('failed to send smoke announcement')
  await session.onUserMessage(prompt, [], messageId)
  await waitForSmokeIdle(session, 5 * 60_000)
  console.log('会话已空闲；请核对群内回复和卡片。')
} finally {
  await session.stop('smoke 结束')
}
