import { describe, expect, test } from 'bun:test'
import { consultIdentityListCard, consultRunCard, consultReviewerElementId } from './consult'
import type { ConsultIdentity } from '../consult-identities'
import type { ConsultRunSnapshot } from '../consult-types'

const identity: ConsultIdentity = {
  id: 'catalog:test',
  displayName: 'GLM · GLM-5.3',
  tokenSourceId: 'glm',
  tokenSourceDisplay: 'GLM',
  provider: 'claude',
  model: 'GLM-5.3',
  modelDisplay: 'GLM-5.3',
  effort: 'max',
  supportedEfforts: ['max'],
  sourceDefault: true,
  origin: 'catalog',
  status: 'ready',
  role: 'general',
}

describe('consult cards', () => {
  test('renders global catalog and preset controls', () => {
    const card = consultIdentityListCard({
      panelId: 'panel-1', page: 0, totalPages: 1,
      catalog: [identity], presets: [], failures: [],
    }) as any
    const json = JSON.stringify(card)
    expect(json).toContain('全局评审身份')
    expect(json).toContain('GLM-5.3')
    expect(json).toContain('consult_identity_add')
    expect(json).toContain('panel-1')
  })

  test('renders one stable reviewer panel per identity and terminal footer', () => {
    const run: ConsultRunSnapshot = {
      runId: 'consult-1', sessionName: 'project', kind: 'review',
      target: { type: 'uncommitted_changes' }, question: '', instructions: '',
      crossReview: false, status: 'completed', targetFingerprint: 'a'.repeat(64),
      reviewers: [{
        identityId: identity.id, identityName: identity.displayName,
        tokenSourceId: 'glm', model: 'GLM-5.3', effort: 'max',
        status: 'completed', output: '未发现具体问题\n![remote](https://example.com/a.png)',
      }],
      createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
    }
    const card = consultRunCard(run) as any
    const json = JSON.stringify(card)
    expect(json).toContain(consultReviewerElementId(identity.id))
    expect(consultReviewerElementId(identity.id).length).toBeLessThanOrEqual(20)
    expect(json).toContain('未发现具体问题')
    expect(json).not.toContain('![remote]')
    expect(json).toContain('咨询完成')
    expect(card.config.streaming_mode).toBe(false)
  })
})
