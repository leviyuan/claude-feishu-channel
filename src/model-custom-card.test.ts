import { test, mock, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lodestar-card-'))
writeFileSync(join(dir, 'config.toml'), `[feishu]
app_id = "x"
app_secret = "s"
[token_source.glm]
base_url = "https://open.bigmodel.cn/api/anthropic"
auth_token = "test-token"
`)
process.env.LODESTAR_CONFIG = join(dir, 'config.toml')
process.env.LODESTAR_DATA_DIR = join(dir, 'data')
mkdirSync(join(dir, 'data'))

// verifyModel mock:不打真端点,按名字决定判定。
mock.module('./model-existence', () => ({
  verifyModelExists: async (_b: string, _h: Record<string, string>, model: string) =>
    model.toLowerCase() === 'glm-5.3' ? 'exists' : 'not_found',
}))
mock.module('./token-source-models', () => ({
  CLAUDE_EFFORTS: ['max', 'xhigh', 'high', 'medium', 'low'],
  fetchGlmModels: async () => [{ model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['max'], defaultEffort: 'max' }],
  fetchCodexModels: async () => [],
}))

// cardkit 走 globalThis.fetch 拦截(与 cardkit.test 同款;不 mock.module cardkit,
// 那样会进程级污染其他文件的 cardkit 导入)。记录 elements 更新请求体。
const elementPatches: any[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const path = url.pathname.replace('/open-apis/cardkit/v1', '')
  if (path.endsWith('/tenant_access_token/internal')) {
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (path === '/cards/id_convert') {
    return new Response(JSON.stringify({ code: 0, data: { card_id: 'card_fake' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (init?.method === 'PUT' && /\/cards\/[^/]+\/elements\//.test(path)) {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    elementPatches.push(typeof body.element === 'string' ? JSON.parse(body.element) : body)
  }
  return new Response(JSON.stringify({ code: 0, data: {} }), {
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

afterEach(() => { elementPatches.length = 0 })
process.on('exit', () => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

await import('./token-source-builtins')
const {
  getTokenSource,
  refreshAllTokenSourceModels,
  registerTokenSource,
  resetTokenSourceRegistry,
  tokenSourceFactories,
} = await import('./token-source')
const { onModelCustomPrompt, consumeModelCustomMessage } = await import('./session-model')

test('补录回复原位更新卡片:通过→effort 选择面板,失败→红字面板,不单发消息', async () => {
  // 不依赖进程里其他测试对 ./config 的 mock.module 覆盖；直接用显式测试
  // 凭据构造 GLM source，避免全量 suite 加载顺序决定 enabled 状态。
  resetTokenSourceRegistry()
  const glmFactory = tokenSourceFactories().find(factory => factory.kind === 'glm-coding-plan')!
  registerTokenSource(glmFactory.build({
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    auth_token: 'test-token',
    model: 'GLM-5.2',
  }, null))
  await refreshAllTokenSourceModels()
  const glm = getTokenSource('glm')
  const fake: any = {
    chatId: 'c', sessionName: 's', modelPanels: new Map(), modelCustomPrompt: null,
    currentTokenSource: () => glm, currentModelLabel: () => 'GLM-5.2', currentEffortLabel: () => 'max', currentTurn: null,
  }

  await onModelCustomPrompt(fake, 'glm', 'p1', 'om_card_1')
  expect(fake.modelCustomPrompt?.cardMessageId).toBe('om_card_1')

  // 通过:modelPanel 元素被原位替换成「选择 effort」面板(点列表模型同款)。
  await consumeModelCustomMessage(fake, 'GLM-5.3', 'u')
  const el = elementPatches.at(-1)
  expect(el).toBeTruthy()
  expect(el.header?.title?.content).toBe('选择 effort')
  expect(JSON.stringify(el)).toContain('GLM-5.3')
  expect(fake.modelCustomPrompt).toBeNull()  // 一次性
  expect(fake.modelPanels.get('p1')?.models.some((m: any) => m.model === 'GLM-5.3')).toBe(true)

  // 失败:modelPanel 换红字面板,模型不进列表。
  fake.modelCustomPrompt = { sourceId: 'glm', panelId: 'p2', cardMessageId: 'om_card_2' }
  await consumeModelCustomMessage(fake, 'glm-9.9', 'u')
  const el2 = elementPatches.at(-1)
  expect(JSON.stringify(el2)).toContain('未加入')
  expect(JSON.stringify(el2)).toContain('glm-9.9')
  expect(glm!.models.some(m => m.model === 'glm-9.9')).toBe(false)
})
