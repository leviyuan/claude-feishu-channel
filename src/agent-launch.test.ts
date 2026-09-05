import { expect, test } from 'bun:test'
import { createAgentProcess } from './agent-launch'
import { listTokenSources, registerTokenSource, resetTokenSourceRegistry, type TokenSource } from './token-source'

for (const status of ['idle', 'loading', 'failed', 'ready'] as const) {
  test(`launch reports ${status} catalog state without substituting a model`, () => {
    const previous = listTokenSources()
    resetTokenSourceRegistry()
    const source: TokenSource = {
      id: 'launch-test', kind: 'test', agent: 'codex', display: 'Test Codex', enabled: true,
      models: [], defaultModel: '', modelCatalogState: { status, updatedAt: null, error: 'catalog upstream unavailable' },
      refreshModels: async () => {},
      spawnEnv: env => env,
      resolveSpawnModel: model => model,
      readUsage: async () => ({ state: 'not_applicable', windows: [] }),
    }
    registerTokenSource(source)
    try {
      const expected = status === 'failed'
        ? 'model catalog refresh failed for launch-test: catalog upstream unavailable'
        : status === 'ready'
          ? 'model is not present in token source launch-test: gpt-6-astra'
          : `model catalog is not ready for launch-test: ${status}`
      expect(() => createAgentProcess({
        provider: 'codex', workDir: '/tmp', tokenSourceId: source.id, model: 'gpt-6-astra', effort: 'ultra',
      })).toThrow(expected)
    } finally {
      resetTokenSourceRegistry()
      for (const item of previous) registerTokenSource(item)
    }
  })
}
