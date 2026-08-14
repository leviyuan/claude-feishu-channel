import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lodestar-cwo-'))
process.env.LODESTAR_DATA_DIR = dir

const {
  observeContextWindow,
  downgradeContextWindow,
  resolveModelWithWindow,
  observedContextWindow,
  resetContextWindowCache,
} = await import('./context-window-observe')

/** 与 observe 模块同款惰性路径(env 优先),保证 rm/读的就是模块写的那个文件。 */
function cacheFile(): string {
  return `${dir.replace(/\/+$/, '')}/context-window-cache.json`
}

beforeEach(() => resetContextWindowCache())
afterEach(() => { if (existsSync(cacheFile())) rmSync(cacheFile()) })

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

  test('爆窗降级 → 记 200K,下轮裸名', () => {
    observeContextWindow('glm', 'GLM-5.3', 1_000_000)  // 先误判 1M
    downgradeContextWindow('glm', 'GLM-5.3[1m]')        // 真实爆窗纠正
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

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
