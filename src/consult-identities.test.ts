import { describe, expect, test } from 'bun:test'
import {
  buildConsultIdentityCatalog,
  catalogIdentityId,
  type ConsultIdentityPreset,
} from './consult-identities'
import type { TokenSource } from './token-source'

function source(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    id: 'glm',
    kind: 'test',
    agent: 'claude',
    display: 'GLM',
    enabled: true,
    models: [
      { model: 'GLM-5.3', display: 'GLM-5.3', efforts: ['max', 'high'], defaultEffort: 'max' },
      { model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['high'], defaultEffort: 'high' },
    ],
    modelCatalogState: { status: 'ready', updatedAt: 1 },
    defaultModel: 'GLM-5.3',
    refreshModels: async () => {},
    spawnEnv: env => env,
    resolveSpawnModel: model => model,
    readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    ...overrides,
  }
}

describe('consult identity catalog', () => {
  test('returns every model with literal max default and exposes unsupported max', () => {
    const catalog = buildConsultIdentityCatalog([source()])
    expect(catalog.identities).toHaveLength(2)
    expect(catalog.identities[0]).toMatchObject({
      id: catalogIdentityId('glm', 'GLM-5.3'),
      effort: 'max',
      sourceDefault: true,
      status: 'ready',
    })
    expect(catalog.identities[1]).toMatchObject({
      model: 'GLM-5.2',
      effort: 'max',
      status: 'effort_unsupported',
    })
  })

  test('matches a configured source default after removing the internal [1m] suffix', () => {
    const catalog = buildConsultIdentityCatalog([source({
      defaultModel: 'GLM-5.2[1m]',
      models: [{ model: 'GLM-5.2', display: 'GLM-5.2', efforts: ['max'], defaultEffort: 'max' }],
    })])
    expect(catalog.identities[0].sourceDefault).toBe(true)
  })

  test('keeps disabled-source models visible but uncallable', () => {
    const catalog = buildConsultIdentityCatalog([source({
      enabled: false,
      modelCatalogState: { status: 'disabled', updatedAt: 2 },
    })])
    expect(catalog.identities.every(identity => identity.status === 'source_disabled')).toBe(true)
    expect(catalog.sourceFailures[0]).toMatchObject({ tokenSourceId: 'glm', status: 'disabled' })
  })

  test('materializes global role presets without replacing catalog identities', () => {
    const baseId = catalogIdentityId('glm', 'GLM-5.3')
    const preset: ConsultIdentityPreset = {
      id: 'preset:one',
      name: '架构审查员',
      baseIdentityId: baseId,
      role: 'architecture',
      effort: 'max',
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    const catalog = buildConsultIdentityCatalog([source()], [preset])
    expect(catalog.identities).toHaveLength(3)
    expect(catalog.identities.at(-1)).toMatchObject({
      id: 'preset:one',
      origin: 'preset',
      role: 'architecture',
      model: 'GLM-5.3',
      status: 'ready',
    })
    expect(catalog.identities.at(-1)?.instructions).toContain('模块边界')
  })

  test('surfaces catalog refresh failures without stale identities', () => {
    const catalog = buildConsultIdentityCatalog([source({
      models: [],
      modelCatalogState: { status: 'failed', updatedAt: 3, error: 'HTTP 503' },
    })])
    expect(catalog.identities).toEqual([])
    expect(catalog.sourceFailures[0]).toMatchObject({ status: 'failed', reason: 'HTTP 503' })
  })
})
