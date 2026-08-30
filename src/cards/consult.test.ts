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

  test('bounds an oversized question in the card while preserving an explicit full-content receipt', () => {
    const question = 'Q'.repeat(108_772)
    const run: ConsultRunSnapshot = {
      runId: 'consult-oversized', sessionName: 'project', kind: 'question',
      target: { type: 'working_directory' }, question, instructions: '',
      crossReview: false, status: 'completed', targetFingerprint: 'b'.repeat(64),
      reviewers: [{
        identityId: identity.id, identityName: identity.displayName,
        tokenSourceId: 'glm', model: 'GLM-5.3', effort: 'max',
        status: 'completed', output: 'O'.repeat(2_676),
      }],
      createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
    }

    const card = consultRunCard(run)
    const json = JSON.stringify(card)

    // 现场样本修复前最终卡约 128KB，被 Card Kit 以 200860 拒绝。
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(64_000)
    expect(json).toContain('问题预览已截断')
    expect(json).toContain('完整问题仍原样交给 reviewer，并保存在 consult 结果文件中')
    expect(json).not.toContain(question)
    // 模板保持纯函数，只限制展示；权威 snapshot 不能被改写。
    expect(run.question).toBe(question)
  })

  test('shares a bounded card preview budget across a large reviewer batch', () => {
    const reviewers = Array.from({ length: 24 }, (_, index) => ({
      identityId: `catalog:reviewer-${index}`,
      identityName: `Reviewer ${index}`,
      tokenSourceId: 'glm', model: 'GLM-5.3', effort: 'max' as const,
      status: 'completed' as const, output: `reviewer-${index}-` + 'R'.repeat(20_000),
    }))
    const run: ConsultRunSnapshot = {
      runId: 'consult-many', sessionName: 'project', kind: 'review',
      target: { type: 'working_directory' },
      question: 'Q'.repeat(108_772), instructions: 'I'.repeat(50_000),
      crossReview: false, status: 'completed', targetFingerprint: 'c'.repeat(64),
      reviewers,
      createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
    }

    const json = JSON.stringify(consultRunCard(run))

    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(96_000)
    expect(json).toContain('问题预览已截断')
    expect(json).toContain('要求预览已截断')
    expect(json.match(/卡片输出已截断/g)).toHaveLength(reviewers.length)
    expect(run.reviewers.every(reviewer => reviewer.output.length > 20_000)).toBe(true)
  })
})
