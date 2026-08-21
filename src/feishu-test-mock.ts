/**
 * 共享的 ./feishu 测试替身(仅供 *.test.ts import)。
 *
 * bun 的 mock.module 是进程级注册:多个测试文件各自 mock('./feishu')
 * 时,后加载的会就地覆盖先加载的 —— cardkit.test.ts 的窄 mock(只有
 * getTenantToken)曾把 session.test.ts 的全量 mock 顶掉,导致
 * `bun test src/` 单进程全跑时 Session 构造函数炸
 * getSessionModelSelection。收敛为这一个模块后,模块缓存保证
 * mock.module 只注册一次,加载顺序不再影响结果。
 *
 * 捕获数组是共享可变状态,测试文件在 beforeEach 里调 resetFeishuMock()。
 */
import { mock } from 'bun:test'

export const sentCards: object[] = []
export const sentTexts: string[] = []
export const sentRawTexts: string[] = []
export const deletedReactions: Array<[string, string]> = []
export const boundResumes: Array<[string, string, string | undefined]> = []
export const urgentPushes: Array<[string, string[]]> = []
/** task v2 list 调用捕获(测 tasklist-worker 的 scanTaskSections 调用预算:每个 section
 *  只能拉一次,防 2026-07-30 修掉的双重拉取回归)。beforeEach 调 resetFeishuMock() 清空。 */
export const listSectionTasksCalls: Array<[string, boolean | undefined]> = []
export const listTasklistSectionsCalls: string[] = []
export const listTasklistTasksCalls: Array<[string, boolean | undefined]> = []
export const modelSelections = new Map<string, {
  provider: 'codex' | 'claude'
  model: string | null
  effort: string | null
  tokenSourceId?: string | null
}>()
/** [projects.<name>] 项目 profile 替身,测试往里 set 后 Session 构造时可查到。 */
export const projectProfiles = new Map<string, { cwd?: string }>()

export function resetFeishuMock(): void {
  for (const arr of [sentCards, sentTexts, sentRawTexts, deletedReactions, boundResumes, urgentPushes]) {
    arr.length = 0
  }
  for (const arr of [listSectionTasksCalls, listTasklistSectionsCalls, listTasklistTasksCalls]) {
    arr.length = 0
  }
  projectProfiles.clear()
  modelSelections.clear()
}

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  resolveProjectDir: (name: string) => projectProfiles.get(name)?.cwd?.trim() || `/tmp/lodestar-projects/${name}`,
  getSessionResume: () => null,
  getSessionModelSelection: (sessionName: string) => modelSelections.get(sessionName) ?? null,
  getTenantToken: async () => 'tenant-token',
  preferredChatForSession: new Map(),
  sendCard: async (_chatId: string, card: object) => {
    sentCards.push(card)
    return `om_status_${sentCards.length}`
  },
  sendText: async (_chatId: string, text: string) => {
    sentTexts.push(text)
    return 'om_text'
  },
  sendTextRaw: async (_chatId: string, text: string) => {
    sentRawTexts.push(text)
    return 'om_raw'
  },
  deleteReaction: async (messageId: string, reactionId: string) => {
    deletedReactions.push([messageId, reactionId])
  },
  urgentApp: async (messageId: string, openIds: string[]) => {
    urgentPushes.push([messageId, openIds])
  },
  listSectionTasks: async (guid: string, completed?: boolean) => {
    listSectionTasksCalls.push([guid, completed])
    return []
  },
  listTasklistSections: async (guid: string) => {
    listTasklistSectionsCalls.push(guid)
    return []
  },
  listTasklistTasks: async (guid: string, completed?: boolean) => {
    listTasklistTasksCalls.push([guid, completed])
    return []
  },
  bindSessionResume: (sessionName: string, sessionId: string, provider?: string) => {
    boundResumes.push([sessionName, sessionId, provider])
  },
  bindSessionModel: () => {},
  isOpenAIChatGPTAuthenticated: () => true,
  provisionProject: () => {},
  projectProfile: (name: string) => projectProfiles.get(name),
  // 临时群 / fork / back / rs 恢复相关 stub(测试不验证这些路径,no-op / 空返回)
  tempProjectName: () => null,
  tempChatName: (project: string) => `${project}*0000-0000`,
  appendTurnAnchor: () => {},
  getTurnAnchors: () => [],
  truncateTurnAnchors: () => {},
  seedTurnAnchors: () => {},
  clearTurnAnchors: () => {},
  ensureChatForSession: async (chatName: string) => ({ chatId: `oc_${chatName}`, created: true, joined: true }),
  disbandChatForSession: async () => ({ chatId: null, disbanded: true }),
}))
