import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config mock:glm source 读 config.claude.env(spawnEnv);token_sources 给空。
mock.module('./config', () => ({
  config: {
    claude: { env: {}, models: {} },
    codex: { env: {} },
    token_sources: {},
  },
}))

// fetchGlmModels mock:上游列表滞后场景(只列到 GLM-5.2,无 5.3)。
let modelsResponse: any[] = []
mock.module('./token-source-models', () => ({
  CLAUDE_EFFORTS: ['max', 'xhigh', 'high', 'medium', 'low'],
  fetchGlmModels: async () => modelsResponse,
}))

// 窗口观测:用真模块(进程级 mock.module 会污染其他测试文件的真模块导入),
// 测试里直连 LODESTAR_DATA_DIR 指向 tmp,数据经 observeContextWindow 注入。
process.env.LODESTAR_DATA_DIR = mkdtempSync(join(tmpdir(), 'lodestar-glm-obs-'))
const {
  observeContextWindow,
  resetContextWindowCache,
} = await import('./context-window-observe')

const { resetTokenSourceRegistry, tokenSourceFactories } = await import('./token-source')
await import('./token-source-glm')

const glmFactory = tokenSourceFactories().find(f => f.kind === 'glm-coding-plan')!

beforeEach(() => {
  resetTokenSourceRegistry()
  resetContextWindowCache()
  modelsResponse = [
    { model: 'GLM-5.2', display: 'GLM-5.2' },
    { model: 'GLM-4.7', display: 'GLM-4.7' },
  ]
})

function buildGlm(cfg: Record<string, any> = {}) {
  return glmFactory.build({
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    auth_token: 'test-token',
    ...cfg,
  })
}

describe('glm models config 补充', () => {
  test('config models 键的 slug 补登到动态列表尾(上游未列出时)', async () => {
    const ts = buildGlm({ models: 'GLM-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7', 'GLM-5.3'])
  })

  test('上游已列出的 slug 不重复(自动收敛为 no-op)', async () => {
    const ts = buildGlm({ models: 'GLM-5.2, GLM-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7', 'GLM-5.3'])
  })

  test('大小写不敏感去重(上游 id 小写、config 大写)', async () => {
    modelsResponse = [{ model: 'GLM-5.3', display: 'GLM-5.3' }]
    const ts = buildGlm({ models: 'glm-5.3' })
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.3'])
  })

  test('无 models 键 = 纯动态列表,行为不变', async () => {
    const ts = buildGlm()
    await ts.refreshModels()
    expect(ts.models.map(m => m.model)).toEqual(['GLM-5.2', 'GLM-4.7'])
  })

  test('补登模型带 CLAUDE_EFFORTS / defaultEffort=max', async () => {
    const ts = buildGlm({ models: 'GLM-5.3' })
    await ts.refreshModels()
    const m = ts.models.find(m => m.model === 'GLM-5.3')!
    expect(m.efforts).toEqual(['max', 'xhigh', 'high', 'medium', 'low'])
    expect(m.defaultEffort).toBe('max')
  })
})

describe('glm [1m] 后缀 = 真实窗口观测决策', () => {
  test('未观测 → 默认加 [1m](客户端记账最大化)', () => {
    const ts = buildGlm()
    expect(ts.resolveSpawnModel('GLM-5.2')).toBe('GLM-5.2[1m]')
    expect(ts.resolveSpawnModel('GLM-5.3')).toBe('GLM-5.3[1m]')
  })

  test('观测 1M → 加 [1m];观测/降级 200K → 裸名', () => {
    const ts = buildGlm()
    observeContextWindow('glm', 'GLM-5.3', 1_000_000)
    observeContextWindow('glm', 'GLM-4.7', 200_000)
    expect(ts.resolveSpawnModel('GLM-5.3')).toBe('GLM-5.3[1m]')
    expect(ts.resolveSpawnModel('GLM-4.7')).toBe('GLM-4.7')
  })

  test('refreshModels 的 1M 标注来自观测缓存(未观测 = 无标注,如实 MISS)', async () => {
    const ts = buildGlm()
    observeContextWindow('glm', 'GLM-5.2', 1_000_000)
    await ts.refreshModels()
    expect(ts.models.find(m => m.model === 'GLM-5.2')?.context1m).toBe(true)
    expect(ts.models.find(m => m.model === 'GLM-4.7')?.context1m).toBeUndefined()
  })
})
