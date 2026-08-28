import { describe, expect, test } from 'bun:test'
import {
  buildConsultPrompt,
  codexConsultConfigOverrides,
  stripConsultCapabilityEnv,
} from './consult-runner'
import type { ConsultIdentity } from './consult-identities'

const identity: ConsultIdentity = {
  id: 'preset:security', displayName: '安全审查员', tokenSourceId: 'deepseek',
  tokenSourceDisplay: 'DeepSeek', provider: 'claude', model: 'deepseek-v3', modelDisplay: 'DeepSeek V3',
  effort: 'max', supportedEfforts: ['max'], sourceDefault: true, origin: 'preset', status: 'ready',
  role: 'security', instructions: '检查凭据与命令注入',
}

describe('consult runner policy', () => {
  test('uses Landlock for Linux without weakening other platform sandboxes', () => {
    expect(codexConsultConfigOverrides('linux')).toContain('features.use_legacy_landlock=true')
    expect(codexConsultConfigOverrides('darwin')).not.toContain('features.use_legacy_landlock=true')
    expect(codexConsultConfigOverrides('linux')).toContain('mcp_servers={}')
    expect(codexConsultConfigOverrides('linux')).toContain('web_search="live"')
  })
  test('strips recursive consultation capabilities from reviewer environments', () => {
    expect(stripConsultCapabilityEnv({
      PATH: '/bin',
      LODESTAR_CONSULT_URL: 'http://127.0.0.1',
      LODESTAR_CONSULT_CAPABILITY: 'secret',
      LODESTAR_CONSULT_SESSION: 'project',
    })).toEqual({ PATH: '/bin' })
  })

  test('builds one bounded peer-review prompt with role and evidence requirements', () => {
    const prompt = buildConsultPrompt({
      identity,
      kind: 'review',
      question: '',
      instructions: '重点查竞态',
      targetContext: 'diff',
      peerOutputs: [{ name: 'GLM', output: 'finding A' }],
    })
    expect(prompt).toContain('检查凭据与命令注入')
    expect(prompt).toContain('其他顾问首轮结果')
    expect(prompt).toContain('finding A')
    expect(prompt).toContain('不修改任何文件')
  })
})
