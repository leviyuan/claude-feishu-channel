import { existsSync, readFileSync } from 'node:fs'
import { AGENT_SESSION_IDS_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'
import type { AgentProvider } from './agent-process'

interface AgentSessionStore {
  version: 1
  ids: string[]
}

let keys = new Set<string>()
let loadError: Error | null = null

function key(provider: AgentProvider, sessionId: string): string {
  return `${provider}:${sessionId}`
}

function load(): void {
  if (!existsSync(AGENT_SESSION_IDS_FILE)) return
  try {
    const raw = JSON.parse(readFileSync(AGENT_SESSION_IDS_FILE, 'utf8')) as AgentSessionStore
    if (raw?.version !== 1 || !Array.isArray(raw.ids) || raw.ids.some(id => typeof id !== 'string' || !id)) {
      throw new Error('invalid delegated-agent session registry')
    }
    keys = new Set(raw.ids)
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error))
  }
}

load()

function assertLoaded(): void {
  if (loadError) throw new Error(`delegated-agent session registry is unavailable: ${loadError.message}`)
}

export function rememberAgentSession(provider: AgentProvider, sessionId: string): void {
  assertLoaded()
  const normalized = sessionId.trim()
  if (!normalized) throw new Error('delegated-agent session id is empty')
  const value = key(provider, normalized)
  if (keys.has(value)) return
  const next = new Set(keys)
  next.add(value)
  writeJsonStateAtomic(AGENT_SESSION_IDS_FILE, {
    version: 1,
    ids: [...next].sort(),
  } satisfies AgentSessionStore)
  keys = next
}

export function isAgentSession(provider: AgentProvider, sessionId: string): boolean {
  assertLoaded()
  return keys.has(key(provider, sessionId))
}

export function resetAgentSessionRegistryForTest(ids: string[] = []): void {
  keys = new Set(ids)
  loadError = null
}
