import { describe, expect, test } from 'bun:test'
import type { AgentIdentity } from '../agent-identities'
import type { AgentRunSnapshot } from '../agent-run-types'
import { agentIdentityListCard, agentRunCard, agentWorkerElementId } from './agents'

const identity: AgentIdentity = {
  id: 'agent:a', displayName: 'GLM · 5.3', tokenSourceId: 'glm', tokenSourceDisplay: 'GLM',
  provider: 'claude', model: 'GLM-5.3', modelDisplay: '5.3', defaultEffort: 'max',
  supportedEfforts: ['low', 'max'], sourceDefault: true, status: 'ready',
}

describe('delegated Agent cards', () => {
  test('renders the catalog as executable Agents without reviewer controls', () => {
    const card = JSON.stringify(agentIdentityListCard({ panelId: 'p', page: 0, totalPages: 1, catalog: [identity], failures: [] }))
    expect(card).toContain('完整 Agent')
    expect(card).toContain('agent_identity_page')
    expect(card).not.toContain('评审角色')
  })

  test('renders needs_input and native session metadata', () => {
    const run: AgentRunSnapshot = {
      runId: 'agent_r', sessionName: 'project', chatId: 'chat', workDir: '/repo', prompt: 'do it',
      depth: 1, status: 'needs_input', createdAt: new Date().toISOString(), workers: [{
        identityId: identity.id, identityName: identity.displayName, tokenSourceId: 'glm', provider: 'claude',
        model: identity.model, effort: 'max', status: 'needs_input', output: '', sessionId: 'sid', steps: [],
        pendingInput: { requestId: 'req', questions: [{ id: 'q', question: 'Proceed?', options: [{ label: 'Yes' }] }] },
      }],
    }
    const card = JSON.stringify(agentRunCard(run))
    expect(card).toContain('等待主 Agent 回答')
    expect(card).toContain('Proceed?')
    expect(card).toContain(agentWorkerElementId(identity.id))
  })
})
