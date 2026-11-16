// bench's server facet: read-only views over runs/ for the Bench surface (the matrix, one run, a transcript page, a
// screenshot, the run in progress) and `cancel`, which only the UI may call.
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineExtension } from '@earendil-works/pi-durable'

export default defineExtension({ name: 'bench' })

type Ctx = { host: { projectRoot: string } }

/** The fields of `runs/<id>/result.json` read here (src/run.ts writes it). */
type RunResult = {
  id: string
  pass: boolean
  status: string
  minutes?: number
  startedAt?: string
  pins: { ultimateCommit: string; setup: string; scenario: string; scenarioSha: string }
  features?: Record<string, boolean>
  sim?: { costUsd: number }
  [key: string]: unknown
}
type Group = { runs: RunResult[]; [key: string]: unknown }

/** The matrix, from the project's own src/report.ts, so the surface and `pnpm eval report` agree. */
const groups = async (ctx: Ctx, runs: RunResult[]) => {
  const report = (await import(pathToFileURL(join(ctx.host.projectRoot, 'src/report.ts')).href)) as {
    groups: (runs: RunResult[]) => Group[]
  }
  return report.groups(runs)
}

const runsDir = (ctx: Ctx) => join(ctx.host.projectRoot, 'runs')
/** No file larger than this is read: what run.ts writes stays far below it (transcripts are well under 1 MB). */
const MAX_FILE = 16 * 1024 * 1024
const readJson = <T>(path: string): T | undefined => {
  try {
    if (statSync(path).size > MAX_FILE) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
/** A run id as run.ts makes it; anything else never reaches the file system. */
const runId = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{8}t\d{4}-[0-9a-f]{7}-[a-z0-9]{4}$/.test(value)) throw new Error('Expected a run id')
  return value
}
const fileName = (value: unknown, pattern: RegExp, what: string) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Expected ${what}`)
  return value
}
const arg = (args: unknown, key: string) => (args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined)

/**
 * Is `pid` this project's eval runner, still alive? `pnpm eval run` execs `node src/cli.ts run …` in the project root:
 * the executable is node, its script is this project's src/cli.ts, the subcommand right after it is `run`. Guards cancel
 * against a reused pid and against any other process that merely mentions those words.
 */
const isRunner = (pid: unknown, ctx: Ctx) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`)
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const script = argv.findIndex((a, i) => i > 0 && !a.startsWith('-'))
    return (
      basename(exe) === 'node' &&
      script > 0 &&
      resolve(cwd, argv[script]!) === join(ctx.host.projectRoot, 'src/cli.ts') &&
      argv[script + 1] === 'run'
    )
  } catch {
    return false
  }
}

type Live = { id: string; pid: number; updatedAt: number; [key: string]: unknown }
type InProgress =
  | ({ kind: 'running' } & Live)
  | { kind: 'legacy'; id: string; commit?: string; launchedAt: number }

/**
 * Runs without a result: with a live.json from a runner still alive (`running`), or from an old runner that writes none
 * while its /tmp/ue-run-<id> exists (`legacy`). Anything else without a result is abandoned and left out.
 */
function inProgress(ctx: Ctx): InProgress[] {
  const dir = runsDir(ctx)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{8}t\d{4}-/.test(name) && !existsSync(join(dir, name, 'result.json')))
    .flatMap((id): InProgress[] => {
      const live = readJson<Live>(join(dir, id, 'live.json'))
      if (live) return isRunner(live.pid, ctx) ? [{ ...live, kind: 'running' }] : []
      if (!existsSync(`/tmp/ue-run-${id}`)) return []
      const stat = statSync(join(dir, id))
      return [{ kind: 'legacy', id, commit: id.split('-')[1], launchedAt: stat.birthtimeMs || stat.mtimeMs }]
    })
}

/** The fields of a result the list and matrix need, without scorecard detail. */
const summary = (r: RunResult) => {
  const card = r.scorecard as
    | { usage: { totalCostUsd: number; cacheHitRate: number }; coordinators: { landed: boolean }[]; questions: { asked: number } }
    | undefined
  const failure = r.failure as { reason: string; atMin?: number; detail?: string; stuck?: unknown } | undefined
  return {
    id: r.id,
    pass: r.pass,
    status: r.status,
    minutes: r.minutes,
    startedAt: r.startedAt,
    commit: r.pins.ultimateCommit,
    setup: r.pins.setup,
    scenario: r.pins.scenario,
    features: r.features ?? {},
    // A run that ended early has only `simCostUsd`.
    costUsd: Math.round(((card?.usage.totalCostUsd ?? 0) + (r.sim?.costUsd ?? (r.simCostUsd as number | undefined) ?? 0)) * 100) / 100,
    cacheHitRate: card?.usage.cacheHitRate,
    coordinators: card?.coordinators.length ?? 0,
    landed: card?.coordinators.filter((c) => c.landed).length ?? 0,
    questions: card?.questions.asked ?? 0,
    failure: failure && { reason: failure.reason, atMin: failure.atMin, detail: failure.detail?.split('\n')[0]?.slice(0, 300), stuck: failure.stuck },
  }
}

const readAll = (ctx: Ctx) => {
  const dir = runsDir(ctx)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((name) => {
      const r = readJson<RunResult>(join(dir, name, 'result.json'))
      return r?.pins ? [r] : []
    })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

export const actions = {
  /** Every finished run (newest first), the matrix, and the runs in progress. */
  async overview(_args: unknown, ctx: Ctx) {
    const all = readAll(ctx)
    return {
      runs: all.map(summary),
      matrix: (await groups(ctx, all)).map(({ runs, ...g }) => ({ ...g, n: runs.length, ids: runs.map((r) => r.id) })),
      live: inProgress(ctx),
    }
  },

  /** The runs in progress, polled by the live strip. */
  async live(_args: unknown, ctx: Ctx) {
    return inProgress(ctx)
  },

  /**
   * The runs in progress, compact, for other instances (a sidebar showing "waits on ultimate-eval · run 2/4") and
   * agents: `{ runs: [{ id, scenario, commit, phase, repeat, plan?, startedAt, updatedAt }] }`, times in epoch ms.
   * Reads only the live.json of unfinished runs, from src/live.ts so the shape is tested there.
   */
  async status(_args: unknown, ctx: Ctx) {
    const live = (await import(pathToFileURL(join(ctx.host.projectRoot, 'src/live.ts')).href)) as {
      status: (dir: string, alive: (pid: unknown) => boolean) => unknown
    }
    return live.status(runsDir(ctx), (pid) => isRunner(pid, ctx))
  },

  /**
   * The newest run in progress as `{ label: 'run', index, total }` (its A/B plan place, else its repeat), or null: what
   * Ultimate's `status/status` passes on so another instance shows "waits on ultimate-eval · run 2/4". As cheap as `status`.
   */
  async progress(_args: unknown, ctx: Ctx) {
    const live = (await import(pathToFileURL(join(ctx.host.projectRoot, 'src/live.ts')).href)) as {
      progress: (dir: string, alive: (pid: unknown) => boolean) => { label: string; index: number; total: number } | null
    }
    return live.progress(runsDir(ctx), (pid) => isRunner(pid, ctx))
  },

  /** One run in full: result.json, the simulated user's turns, the transcripts and screenshots it has, test output. */
  async run(args: unknown, ctx: Ctx) {
    const id = runId(arg(args, 'id'))
    const dir = join(runsDir(ctx), id)
    const result = readJson<Record<string, unknown>>(join(dir, 'result.json'))
    if (!result) throw new Error(`Run ${id} has no result`)
    const sim = readJson<{ said: unknown[]; calls: { at: number; decision?: unknown; costUsd?: number; ms?: number; error?: string; applied?: string }[] }>(
      join(dir, 'sim.json'),
    )
    const conversations = readJson<{ id: number; label?: string; title?: string; parentConversationId?: number }[]>(
      join(dir, 'transcripts', 'conversations.json'),
    ) ?? []
    const list = (sub: string, re: RegExp) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((n) => re.test(n)).sort() : [])
    const testsPath = join(dir, 'project-tests.txt')
    const projectTests =
      existsSync(testsPath) && statSync(testsPath).size <= MAX_FILE ? readFileSync(testsPath, 'utf8').slice(-20_000) : undefined
    return {
      result,
      // Without the prompts: they repeat the scenario every turn.
      // run.ts stops at 60 simulated-user calls, so these stay short; the slices only guard a hand-edited file.
      sim: sim && { said: sim.said.slice(-200), calls: sim.calls.slice(-100).map(({ at, decision, costUsd, ms, error, applied }) => ({ at, decision, costUsd, ms, error, applied })) },
      conversations,
      transcripts: list('transcripts', /^\d+\.json$/).map((n) => Number(n.slice(0, -5))),
      screenshots: list('screenshots', /^[\w-]+\.png$/),
      projectTests,
    }
  },

  /**
   * One page of a conversation's transcript, compact: message text whole up to 4,000 characters, tool calls with their
   * arguments cut, tool results kept at start and end. `before` is an exclusive index into the stored entries.
   */
  async transcript(args: unknown, ctx: Ctx) {
    const id = runId(arg(args, 'id'))
    const conversation = Number(fileName(String(arg(args, 'conversation')), /^\d+$/, 'a conversation id'))
    const entries = readJson<{ id: number; kind: string; data?: unknown; model?: { role: string; content?: unknown; timestamp?: number; model?: string; provider?: string; usage?: { cost?: { total?: number } }; toolName?: string; isError?: boolean }[] }[]>(
      join(runsDir(ctx), id, 'transcripts', `${conversation}.json`),
    )
    if (!entries) throw new Error(`No transcript for #${conversation}`)
    const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n / 2)}\n…\n${text.slice(-n / 2)}` : text)
    const texts = (content: unknown) =>
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.flatMap((c: { type: string; text?: string }) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')
          : ''
    const limit = 200
    const before = arg(args, 'before') ?? entries.length
    if (typeof before !== 'number' || !Number.isInteger(before) || before < 0) throw new Error('Expected before: an entry index')
    const end = Math.min(before, entries.length)
    const start = Math.max(0, end - limit)
    const page = entries.slice(start, end).map((e) => {
      const m = e.model?.[0]
      const calls = Array.isArray(m?.content)
        ? (m.content as { type: string; name?: string; arguments?: unknown }[])
            .filter((c) => c.type === 'toolCall')
            .map((c) => ({ name: c.name, args: cut(JSON.stringify(c.arguments ?? {}), 600) }))
        : []
      return {
        id: e.id,
        kind: e.kind,
        role: m?.role,
        at: m?.timestamp,
        model: m?.provider && m.model ? `${m.provider}/${m.model}` : undefined,
        costUsd: m?.usage?.cost?.total,
        tool: m?.toolName,
        isError: m?.isError,
        text: cut(texts(m?.content), m?.role === 'toolResult' ? 1500 : 4000),
        calls,
        // An entry with no message, such as the lander's steps, says what it says in its data.
        ...(!m && e.data !== undefined ? { data: cut(JSON.stringify(e.data), 1500) } : {}),
      }
    })
    return { total: entries.length, start, entries: page }
  },

  /** A screenshot as a data URL. */
  async screenshot(args: unknown, ctx: Ctx) {
    const id = runId(arg(args, 'id'))
    const name = fileName(arg(args, 'name'), /^[\w-]+\.png$/, 'a screenshot name')
    const path = join(runsDir(ctx), id, 'screenshots', name)
    // Playwright's page screenshots are tens of KB; refuse anything that is not one.
    if (statSync(path).size > 4 * 1024 * 1024) throw new Error(`${name} is larger than 4 MB`)
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`
  },

  /** Stop a run in progress: SIGTERM to its runner, which records it as cancelled and stops the remaining repeats. */
  async cancel(args: unknown, ctx: Ctx) {
    const id = runId(arg(args, 'id'))
    const dir = join(runsDir(ctx), id)
    if (existsSync(join(dir, 'result.json'))) throw new Error(`Run ${id} has already finished`)
    const live = readJson<Live>(join(dir, 'live.json'))
    if (!live) throw new Error(`Run ${id} has no live.json; stop it from its terminal`)
    if (!isRunner(live.pid, ctx)) throw new Error(`Run ${id}'s runner (pid ${live.pid}) is not running`)
    process.kill(live.pid, 'SIGTERM')
    return { cancelled: id, pid: live.pid }
  },
}

/** Cancel spends nothing but ends a run Daniel paid for: his choice, never an agent's. */
export const userActions = ['cancel']
/** Polled by the surface while it is open, and `status` and `progress` by the status line and other instances. */
export const pollActions = ['live', 'transcript', 'status', 'progress']
