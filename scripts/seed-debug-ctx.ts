#!/usr/bin/env bun
/** 指定群和成员作为 debug 注入身份。也可由该成员在目标群发送 `[DEBUG]hi`。 */
import { writeJsonStateAtomic } from '../src/state-store'
import { DEBUG_CTX_FILE } from '../src/paths'

const [chatId, memberOpenId] = process.argv.slice(2)
if (!chatId || !memberOpenId) {
  console.error('usage: bun scripts/seed-debug-ctx.ts <chat_id> <member_open_id>')
  process.exit(1)
}

const { client } = await import('../src/feishu')
let pageToken: string | undefined
let memberName: string | undefined
const seenPages = new Set<string>()
while (true) {
  const res = await client.im.v1.chatMembers.get({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
  })
  if (res.code !== 0) throw new Error(`chatMembers.get failed code=${res.code}: ${res.msg}`)
  const member = res.data?.items?.find(item => item.member_id === memberOpenId)
  if (member) {
    memberName = member.name
    break
  }
  if (!res.data?.has_more) throw new Error('the requested member is not in this chat')
  pageToken = res.data.page_token
  if (!pageToken || seenPages.has(pageToken)) throw new Error('chatMembers.get returned invalid pagination')
  seenPages.add(pageToken)
}

writeJsonStateAtomic(DEBUG_CTX_FILE, {
  chat_id: chatId,
  sender_open_id: memberOpenId,
  seeded_at: new Date().toISOString(),
  seeded_by: 'seed-debug-ctx.ts',
  seeded_name: memberName,
})
console.log(`wrote debug context to ${DEBUG_CTX_FILE}`)
