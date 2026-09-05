#!/usr/bin/env bun
/**
 * 对指定真实群依次检查会话命令、回复、工具、附件和中途来消息的行为。
 * bun scripts/test-all.ts <chat_name|chat_id>
 * 目标群的 daemon 必须已停止；卡片内容需人工核对，脚本不处理交互提问。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const target = process.argv[2]
if (!target) {
  console.error('usage: bun scripts/test-all.ts <chat_name|chat_id>')
  process.exit(1)
}
const feishu = await import('../src/feishu')
const { createSmokeSession, waitForSmokeIdle } = await import('./smoke-session')
const session = await createSmokeSession(target)
const artifactDir = mkdtempSync(join(tmpdir(), 'lodestar-smoke-'))
const outputPath = join(artifactDir, 'out.txt')
const sleep = (ms: number) => Bun.sleep(ms)
const announce = async (text: string) => {
  const id = await feishu.sendText(session.chatId, `🧪 ${text}`)
  if (!id) throw new Error('failed to send smoke announcement')
}

function ensureSampleImage(): string {
  const path = join(artifactDir, 'image.png')
  const png = solidRgbPng(60, 60, 255, 0, 0)
  writeFileSync(path, png)
  return path
}

function solidRgbPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const off = row + 1 + x * 3
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length)
  return out
}

const CRC_TABLE = new Uint32Array(256).map((_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

try {
  console.log(`smoke: ${session.sessionName} (${session.chatId})`)

  await announce('[人工检查 START] 会话命令、回复和附件')
  await sleep(1500)

  // ──────────────────────────────────────────────────────────────────────
  // 1) kill on stopped session
  await announce('[1/8] runCommand("kill") @ stopped — 期待 ⚪ 未运行')
  await session.runCommand('kill')
  await sleep(2500)

  // 2) hi → one card starts as progress, then becomes the console
  await announce('[2/8] runCommand("hi") @ stopped — 期待一张卡: ✅ 启动进度 → 控制台')
  await session.runCommand('hi')
  await sleep(4000)

  // 3) basic stream + thinking + tool call
  await announce('[3/8] 基础流：思考 + assistant + Bash 工具')
  await session.onUserMessage('用 Bash 执行 `uname -a && uptime`，然后用一句话总结这台机器现在的状态。')
  await waitForSmokeIdle(session, 120_000)
  await sleep(2000)

  // 4) outbound [[send: /path]]
  await announce(`[4/8] 出站文件：生成 ${outputPath} 并发送回群`)
  await session.onUserMessage(
    `创建文本文件 ${outputPath}，写入 lodestar outbound test，然后在回复中单独一行加 [[send: ${outputPath}]] 发给我。`,
  )
  await waitForSmokeIdle(session, 120_000)
  await sleep(3000)

  // 5) mid-flight interrupt
  await announce('[5/8] 中途打断：发一条慢任务，2s 后再发一条新任务')
  const longRun = session.onUserMessage('请用中文逐字数 1 到 50（每个数字独立一行），慢慢说。')
  await sleep(2000)
  await session.onUserMessage('好了别数了，换个话题：用一句话告诉我今天日期。')
  await longRun
  await waitForSmokeIdle(session, 90_000)
  await sleep(2000)

  // 6) inbound image
  await announce('[6/8] 入站图片：模拟用户发图，传入合成的 60×60 红色 PNG')
  const imgPath = ensureSampleImage()
  await session.onUserMessage('帮我描述一下这张图的颜色和尺寸。', [imgPath])
  await waitForSmokeIdle(session, 120_000)
  await sleep(2000)

  // 7) restart (resume)
  await announce('[7/8] runCommand("restart") — 期待 🔁 resume 同 thread-id')
  await session.runCommand('restart')
  await sleep(5000)

  // 8) clear (fresh — kills + starts new)
  await announce('[8/8] runCommand("clear") — 期待 ⚪ kill + 🚀 启动新 thread')
  await session.runCommand('clear')
  await sleep(5000)

  await announce('[人工检查 END] 已执行 8 个步骤，请逐项核对群内卡片。')
} finally {
  try { await session.stop('smoke 结束') }
  finally { rmSync(artifactDir, { recursive: true, force: true }) }
}
