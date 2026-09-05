import * as feishu from '../src/feishu'
import { Session } from '../src/session'
import { buildTokenSourcesFromConfig } from '../src/token-source-builtins'
import { refreshAllTokenSourceModels } from '../src/token-source'

/** 独立 smoke 使用生产配置和状态；调用前须停止目标群的 daemon。 */
export async function createSmokeSession(target: string): Promise<Session> {
  feishu.loadTempSessionLeases()
  feishu.loadSessionChatMap()
  feishu.loadSessionResumeMap()
  feishu.loadSessionTurnsMap()
  feishu.loadSessionModelMap()
  await feishu.refreshChatList()
  const matches = [...feishu.chatNameCache].filter(([id, name]) => id === target || name === target)
  if (matches.length !== 1) throw new Error(`expected one chat for "${target}", found ${matches.length}; use a unique chat_id`)
  const [chatId, name] = matches[0]
  buildTokenSourcesFromConfig()
  await refreshAllTokenSourceModels()
  const sessionName = feishu.sanitizeSessionName(name)
  feishu.bindSessionToChat(sessionName, chatId)
  return new Session(sessionName, chatId)
}

export async function waitForSmokeIdle(session: Session, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (session.status === 'stopped') throw new Error('smoke session stopped before completion; inspect the agent error')
    if (session.status === 'awaiting_permission') throw new Error('smoke cannot answer interactive questions without a WebSocket listener')
    if (session.status === 'idle' && !session.currentTurn && !session.openingTurn && session.pendingUserMessageCount === 0) return
    await Bun.sleep(200)
  }
  throw new Error(`smoke timed out after ${timeoutMs}ms at status=${session.status}`)
}
