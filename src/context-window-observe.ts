/**
 * 真实上下文窗口观测 —— 零探测、零写死、纯被动。
 *
 * 信息源 = 每轮真实 turn:
 *   · SDK result.modelUsage[model].contextWindow:CLI 客户端按 [1m] 后缀记账
 *     (带后缀报 1M,裸名报 200K)—— turn 一结束就是现成信号。
 *   · 爆窗错误(model_context_window_exceeded):带 [1m] 的模型被服务端 200K
 *     挡下 = 端点没给 1M → 自动降级为裸名(下轮起 200K 记账,不再被拒)。
 *
 * 落盘 `<sourceId>:<model>` → 窗口 token 数,daemon 重启保留。spawn 侧
 * resolveSpawnModel 读它:观测到 1M → 加 [1m];观测到 200K/降级 → 裸名;
 * 未观测 → 默认加 [1m](客户端记账最大化,真实 turn 说了算再修正)。
 * 任何 anthropic 兼容端点通用,无 provider 特判,无模型名白名单。
 */

import { existsSync, readFileSync } from 'node:fs'
import { CONTEXT_WINDOW_CACHE_FILE as CACHE_FILE_CONST } from './paths'
import { log } from './log'
import { writeJsonStateAtomic } from './state-store'

/** 惰性取缓存路径:paths 常量是 import 时按当时 LODESTAR_DATA_DIR 求值的,
 *  测试套件里晚设的 env 要能生效(单跑/全量一致)。生产路径不变。 */
function cacheFile(): string {
  return process.env.LODESTAR_DATA_DIR
    ? `${process.env.LODESTAR_DATA_DIR.replace(/\/+$/, '')}/context-window-cache.json`
    : CACHE_FILE_CONST
}

/** 1M 判定阈值:观测窗口 ≥ 此值视为 1M 能力(实际值只有 200000/1000000 两档)。 */
export const CONTEXT_1M_THRESHOLD = 1_000_000
/** 已知基线窗口(裸名记账):降级/裸名观测都归到这档。 */
export const CONTEXT_BASE_WINDOW = 200_000

type WindowCache = Record<string, number>

let cache: WindowCache | null = null

function loadCache(): WindowCache {
  if (cache !== null) return cache
  try {
    cache = existsSync(cacheFile())
      ? JSON.parse(readFileSync(cacheFile(), 'utf8'))
      : {}
  } catch (e: any) {
    log(`context-window-observe: cache read MISS (${e?.message ?? e}), starting fresh`)
    cache = {}
  }
  return cache ?? {}
}

function saveCache(): void {
  try {
    writeJsonStateAtomic(cacheFile(), loadCache())
  } catch (e: any) {
    log(`context-window-observe: cache write MISS (${e?.message ?? e})`)
  }
}

function keyOf(sourceId: string, model: string): string {
  return `${sourceId}:${model.replace(/\[1m\]$/, '')}`
}

/** 观测上报:真实 turn 的 contextWindow(或爆窗降级)写入缓存。
 *  单调不降?不 —— 降级恰恰要能降(爆窗实测推翻 [1m] 记账),但同值幂等。 */
export function observeContextWindow(sourceId: string, model: string, window: number): void {
  if (!Number.isFinite(window) || window <= 0) return
  const key = keyOf(sourceId, model)
  const prev = loadCache()[key]
  if (prev === window) return
  loadCache()[key] = window
  saveCache()
  log(`context-window-observe: ${key} → ${window} (prev ${prev ?? '-'})`)
}

/** 爆窗降级:带 [1m] 的模型被服务端拒(model_context_window_exceeded)→ 记 200K。
 *  之后 resolveSpawnModel 不再加后缀,下轮起窗口记账回落 200K,不再被拒。 */
export function downgradeContextWindow(sourceId: string, model: string): void {
  observeContextWindow(sourceId, model, CONTEXT_BASE_WINDOW)
}

/** spawn 决策:观测到 1M → 加 [1m];观测 ≤200K/降级 → 裸名;未观测 → 默认 [1m]
 *  (客户端记账最大化;若端点不支持,首轮爆窗即降级,用户损失一轮 turn 的窗口
 *  显示,换来零探测零白名单零 provider 假设)。已带后缀 pass-through。
 *  空模型(端点拉取 MISS 且 config 无 model 键)→ undefined:不下发垃圾串,
 *  spawn 侧走 SDK 默认 alias 路径,失败如实暴露。 */
export function resolveModelWithWindow(sourceId: string, model: string): string | undefined {
  if (!model) return undefined
  if (model.endsWith('[1m]')) return model
  const observed = loadCache()[keyOf(sourceId, model)]
  return observed != null && observed < CONTEXT_1M_THRESHOLD ? model : `${model}[1m]`
}

/** 面板显示用:观测到的窗口(未观测 = undefined,显示侧如实 MISS,不猜)。 */
export function observedContextWindow(sourceId: string, model: string): number | undefined {
  return loadCache()[keyOf(sourceId, model)]
}

/** 仅供测试重置内存缓存。 */
export function resetContextWindowCache(): void {
  cache = null
}
