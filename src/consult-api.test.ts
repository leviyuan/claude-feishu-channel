import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { handleConsultRequest } from './consult-api'

let server: Server | null = null

afterEach(async () => {
  if (!server) return
  await new Promise<void>(resolve => server!.close(() => resolve()))
  server = null
})

async function startApi() {
  const session = { sessionName: 'project', chatId: 'chat-1' } as any
  const run = {
    runId: 'run-1', sessionName: 'project', kind: 'question',
    target: { type: 'working_directory' }, question: 'hello', instructions: '',
    crossReview: false, status: 'completed', targetFingerprint: 'f1', reviewers: [],
    createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
  } as any
  const service = {
    startRun: async () => run,
    getRun: (id: string) => id === 'run-1' ? run : null,
    ownsRun: (id: string) => id === 'run-1',
    cancelRun: async () => true,
  } as any
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    void handleConsultRequest(req, res, url, {
      service,
      authorize: token => token === 'secret' ? session : null,
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  return `http://127.0.0.1:${address.port}`
}

describe('consult HTTP API', () => {
  test('requires a live bearer capability for identity discovery', async () => {
    const base = await startApi()
    expect((await fetch(`${base}/consult/identities`)).status).toBe(401)
    expect((await fetch(`${base}/consult/identities`, {
      headers: { authorization: 'Bearer wrong' },
    })).status).toBe(403)
    const response = await fetch(`${base}/consult/identities`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('identities')
  })

  test('creates, reads, and cancels a consultation run', async () => {
    const base = await startApi()
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const created = await fetch(`${base}/consult/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ identity_ids: ['catalog:a'], kind: 'question', question: 'hello' }),
    })
    expect(created.status).toBe(202)
    expect((await created.json()).run_id).toBe('run-1')
    expect((await fetch(`${base}/consult/runs/run-1`, { headers })).status).toBe(200)
    expect((await fetch(`${base}/consult/runs/run-1`, { method: 'DELETE', headers })).status).toBe(200)
    expect((await fetch(`${base}/consult/runs/%`, { headers })).status).toBe(400)
  })
})
