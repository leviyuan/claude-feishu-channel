import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lodestar-cwo-'))
const originalDataDir = process.env.LODESTAR_DATA_DIR

const {
  observeContextWindow,
  resolveModelWithWindow,
  observedContextWindow,
  resetContextWindowCache,
} = await import('./context-window-observe')

/** 与 observe 模块同款惰性路径(env 优先),保证 rm/读的就是模块写的那个文件。 */
function cacheFile(): string {
  return `${dir.replace(/\/+$/, '')}/context-window-cache.json`
}

beforeAll(() => {
  process.env.LODESTAR_DATA_DIR = dir
})
beforeEach(() => resetContextWindowCache())
afterEach(() => { if (existsSync(cacheFile())) rmSync(cacheFile()) })
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.LODESTAR_DATA_DIR
  else process.env.LODESTAR_DATA_DIR = originalDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('context-window-observe(纯观测,零探测)', () => {
  test('未观测 → 默认加 [1m]', () => {
    expect(resolveModelWithWindow('glm', 'GLM-5.3')).toBe('GLM-5.3[1m]')
  })

  test('观测 1M → 加 [1m]', () => {
    observeContextWindow('glm', 'GLM-5.3', 1_000_000)
    expect(resolveModelWithWindow('glm', 'GLM-5.3')).toBe('GLM-5.3[1m]')
  })

  test('观测 200K → 裸名', () => {
    observeContextWindow('glm', 'GLM-4.7', 200_000)
    expect(resolveModelWithWindow('glm', 'GLM-4.7')).toBe('GLM-4.7')
  })

  test('新 SDK 观测可以纠正窗口为 200K', () => {
    observeContextWindow('glm', 'GLM-5.3', 1_000_000)
    observeContextWindow('glm', 'GLM-5.3[1m]', 200_000)
    expect(resolveModelWithWindow('glm', 'GLM-5.3')).toBe('GLM-5.3')
  })

  test('带后缀观测 key 归一([1m] 剥掉再记)', () => {
    observeContextWindow('glm', 'GLM-5.3[1m]', 1_000_000)
    expect(observedContextWindow('glm', 'GLM-5.3')).toBe(1_000_000)
    expect(resolveModelWithWindow('glm', 'GLM-5.3')).toBe('GLM-5.3[1m]')
  })

  test('已带后缀 pass-through 不重复加', () => {
    observeContextWindow('glm', 'GLM-5.3', 200_000)
    expect(resolveModelWithWindow('glm', 'GLM-5.3[1m]')).toBe('GLM-5.3[1m]')
  })

  test('观测落盘且重启后保留(重置内存缓存再读)', () => {
    observeContextWindow('deepseek', 'deepseek-v4-pro', 1_000_000)
    resetContextWindowCache()
    expect(observedContextWindow('deepseek', 'deepseek-v4-pro')).toBe(1_000_000)
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({
      'deepseek:deepseek-v4-pro': 1_000_000,
    })
    rmSync(cacheFile())  // 后续用例从空缓存开始
  })

  test('source 隔离:同模型名不同 source 互不干扰', () => {
    observeContextWindow('glm', 'X', 200_000)
    expect(resolveModelWithWindow('deepseek', 'X')).toBe('X[1m]')
    expect(resolveModelWithWindow('glm', 'X')).toBe('X')
    rmSync(cacheFile())
  })

  test('非法观测值拒绝(0/负/NaN)', () => {
    observeContextWindow('glm', 'X', 0)
    observeContextWindow('glm', 'X', -5)
    observeContextWindow('glm', 'X', NaN)
    expect(observedContextWindow('glm', 'X')).toBeUndefined()
  })
})
