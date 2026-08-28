import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface CliContext {
  baseUrl: string
  capability: string
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv.shift() ?? ''
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const context = cliContext()
  switch (command) {
    case 'identities': {
      const data = await requestJson(context, 'GET', '/consult/identities')
      if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else process.stdout.write(formatIdentities(data))
      return
    }
    case 'run':
      await runCommand(context, argv)
      return
    case 'status': {
      const runId = requiredArg(argv[0], 'status requires run_id')
      const data = await requestJson(context, 'GET', `/consult/runs/${encodeURIComponent(runId)}`)
      process.stdout.write(formatRun(data))
      if (data.status === 'failed' || data.status === 'cancelled') process.exitCode = 1
      return
    }
    case 'cancel': {
      const runId = requiredArg(argv[0], 'cancel requires run_id')
      const data = await requestJson(context, 'DELETE', `/consult/runs/${encodeURIComponent(runId)}`)
      process.stdout.write(`${JSON.stringify(data)}\n`)
      return
    }
    default:
      throw new Error(usage())
  }
}

async function runCommand(context: CliContext, argv: string[]): Promise<void> {
  const parsed = parseRunArgs(argv)
  const stdin = parsed.readStdin ? await readStdin() : ''
  const question = parsed.question || (parsed.kind !== 'review' ? stdin.trim() : '')
  const target = targetBody(parsed, stdin)
  const body = {
    identity_ids: parsed.identityIds,
    kind: parsed.kind,
    target,
    ...(question ? { question } : {}),
    ...(parsed.instructions ? { instructions: parsed.instructions } : {}),
    ...(parsed.crossReview ? { cross_review: true } : {}),
  }
  const started = await requestJson(context, 'POST', '/consult/runs', body)
  const runId = String(started.run_id ?? '')
  if (!runId) throw new Error('consult API returned no run_id')
  if (parsed.noWait) {
    process.stdout.write(`${JSON.stringify(started, null, 2)}\n`)
    return
  }
  let cancelling = false
  const cancel = () => {
    if (cancelling) return
    cancelling = true
    void requestJson(context, 'DELETE', `/consult/runs/${encodeURIComponent(runId)}`)
      .then(
        () => process.exit(130),
        error => {
          process.stderr.write(`lodestar-consult: cancellation failed: ${error instanceof Error ? error.message : String(error)}\n`)
          process.exit(1)
        },
      )
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    while (true) {
      const run = await requestJson(context, 'GET', `/consult/runs/${encodeURIComponent(runId)}`)
      if (run.status !== 'running') {
        process.stdout.write(formatRun(run))
        if (run.status !== 'completed') process.exitCode = 1
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

interface ParsedRunArgs {
  identityIds: string[]
  kind: 'question' | 'review' | 'critique'
  target: string
  question: string
  instructions: string
  commit: string
  branch: string
  proposal: string
  crossReview: boolean
  noWait: boolean
  readStdin: boolean
}

export function parseRunArgs(argv: string[]): ParsedRunArgs {
  const out: ParsedRunArgs = {
    identityIds: [],
    kind: 'question',
    target: 'working_directory',
    question: '',
    instructions: '',
    commit: '',
    branch: '',
    proposal: '',
    crossReview: false,
    noWait: false,
    readStdin: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => requiredArg(argv[++i], `${arg} requires a value`)
    switch (arg) {
      case '--identity': case '-i': out.identityIds.push(next()); break
      case '--kind': {
        const kind = next()
        if (kind !== 'question' && kind !== 'review' && kind !== 'critique') throw new Error(`invalid --kind: ${kind}`)
        out.kind = kind
        break
      }
      case '--target': out.target = next(); break
      case '--question': out.question = next(); break
      case '--instructions': out.instructions = next(); break
      case '--commit': out.commit = next(); out.target = 'commit'; break
      case '--branch': out.branch = next(); out.target = 'base_branch'; break
      case '--proposal': out.proposal = next(); out.target = 'proposal'; break
      case '--cross-review': out.crossReview = true; break
      case '--no-wait': out.noWait = true; break
      case '--stdin': out.readStdin = true; break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
        positional.push(arg)
    }
  }
  out.identityIds = [...new Set(out.identityIds)]
  if (!out.identityIds.length) throw new Error('run requires at least one --identity')
  if (positional.length && !out.question) out.question = positional.join(' ')
  if (!out.question && !out.proposal && (out.kind !== 'review' || out.target === 'proposal')) out.readStdin = true
  const allowedTargets = new Set(['working_directory', 'uncommitted_changes', 'commit', 'base_branch', 'proposal'])
  if (!allowedTargets.has(out.target)) throw new Error(`invalid --target: ${out.target}`)
  return out
}

function targetBody(parsed: ParsedRunArgs, stdin: string): object {
  switch (parsed.target) {
    case 'commit': return { type: 'commit', sha: requiredArg(parsed.commit, '--commit is required') }
    case 'base_branch': return { type: 'base_branch', branch: requiredArg(parsed.branch, '--branch is required') }
    case 'proposal': {
      const text = parsed.proposal || stdin
      return { type: 'proposal', text: requiredArg(text.trim(), 'proposal text is required') }
    }
    case 'uncommitted_changes': return { type: 'uncommitted_changes' }
    default: return { type: 'working_directory' }
  }
}

function cliContext(): CliContext {
  const baseUrl = String(process.env.LODESTAR_CONSULT_URL ?? '').replace(/\/+$/, '')
  const capability = String(process.env.LODESTAR_CONSULT_CAPABILITY ?? '')
  if (!baseUrl || !capability) {
    throw new Error('lodestar-consult must run inside a Lodestar-managed main Agent session (missing capability)')
  }
  return { baseUrl, capability }
}

async function requestJson(context: CliContext, method: string, path: string, body?: object): Promise<any> {
  const response = await fetch(`${context.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${context.capability}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let value: any
  try { value = JSON.parse(text) }
  catch { throw new Error(`consult API ${method} ${path} returned HTTP ${response.status}: ${text || '(empty)'}`) }
  if (!response.ok) throw new Error(value?.error ?? `consult API HTTP ${response.status}`)
  return value
}

function formatIdentities(value: any): string {
  const lines = [`catalog ${value.catalog_generation ?? 'MISS'}`]
  for (const identity of value.identities ?? []) {
    lines.push([
      identity.status === 'ready' ? '✅' : 'MISS',
      identity.id,
      identity.display_name,
      `${identity.model}/${identity.effort}`,
      identity.source_default ? 'default' : '',
      identity.reason ?? '',
    ].filter(Boolean).join(' · '))
  }
  for (const failure of value.source_failures ?? []) {
    lines.push(`MISS · ${failure.display} · ${failure.reason}`)
  }
  return `${lines.join('\n')}\n`
}

function formatRun(run: any): string {
  const lines = [
    `# Lodestar consult ${run.run_id ?? 'MISS'}`,
    '',
    `- Status: ${run.status ?? 'MISS'}`,
    `- Kind: ${run.kind ?? 'MISS'}`,
    `- Target fingerprint: ${run.target_fingerprint ?? 'MISS'}`,
    `- Cross review: ${run.cross_review ? 'yes' : 'no'}`,
  ]
  if (run.error) lines.push(`- Error: ${run.error}`)
  for (const reviewer of run.reviewers ?? []) {
    lines.push('', `## ${reviewer.identity_name ?? reviewer.identity_id}`, '', `Status: ${reviewer.status}`)
    if (reviewer.error) lines.push('', `Error: ${reviewer.error}`)
    if (reviewer.first_pass_output) lines.push('', '### First pass', '', reviewer.first_pass_output)
    if (reviewer.output) lines.push('', reviewer.first_pass_output ? '### Cross review' : '### Response', '', reviewer.output)
  }
  return `${lines.join('\n')}\n`
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function requiredArg(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message)
  return value.trim()
}

function usage(): string {
  return [
    'Usage:',
    '  lodestar-consult identities [--json]',
    '  lodestar-consult run --identity <id> [--identity <id>...] --kind question|review|critique [options]',
    '  lodestar-consult status <run_id>',
    '  lodestar-consult cancel <run_id>',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`lodestar-consult: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
