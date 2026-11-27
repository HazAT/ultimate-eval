// bench's browser types: the server actions as typed refs, the shapes they return, and small formatters.
import { actionRef } from '@/sdk/solid'
import type { TrendBatch, TrendPass, TrendVersion } from '../../../src/perf/trend.ts'

export type Said = { at: number; who: 'you' | 'ultimate'; text: string }

export type Running = {
  kind: 'running'
  id: string
  pid: number
  phase: string
  commit: string
  setup: string
  scenario: string
  repeat: { index: number; total: number }
  launchedAt: number
  firstPromptAt?: number
  budgetMin: number
  url?: string
  updatedAt: number
  said: Said[]
  busy: { id: number; title?: string; label?: string }[]
  coordinators: { id: number; title?: string; intent?: string; landed: boolean }[]
  open: number
}
export type Legacy = { kind: 'legacy'; id: string; commit?: string; launchedAt: number }
export type InProgress = Running | Legacy

export type Stuck = {
  busy?: { id: number; title?: string; label?: string }[]
  open?: { id: number; from?: number; text: string }[]
  lastSaid?: Said
  lastProgressMin?: number
}
export type Failure = { reason: string; atMin?: number; detail?: string; stuck?: Stuck | null }

export type Summary = {
  id: string
  pass: boolean
  status: string
  minutes?: number
  startedAt?: string
  commit: string
  setup: string
  scenario: string
  features: Record<string, boolean>
  costUsd: number
  cacheHitRate?: number
  coordinators: number
  landed: number
  questions: number
  failure?: Failure
}

export type Group = {
  commit: string
  setup: string
  scenario: string
  scenarioSha: string
  evalCommit?: string
  passes: number
  n: number
  medianMin?: number
  medianCost?: number
  features: Record<string, number>
  multi: { asked: number; answered: number }
  failures: { id: string; status: string }[]
  ids: string[]
}

export type Overview = { runs: Summary[]; matrix: Group[]; live: InProgress[] }

export type Usage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

/** `result.json` as src/run.ts writes it; a run that ended early has only some of it. */
export type Result = {
  id: string
  pass: boolean
  status: string
  startedAt?: string
  finishedAt?: string
  minutes?: number
  startupSec?: number
  pins: {
    ultimateCommit: string
    scenario: string
    scenarioSha: string
    setup: string
    setupSha?: string
    families?: Record<string, { model: string; thinking?: string }>
    /** A family name, or since setups carry overlays `{ family, codeMode? }`. */
    roles?: Record<string, string | { family: string; codeMode?: boolean }>
    simModel?: string
    simEffort?: string
    simPromptSha?: string
    evalCommit?: string
  }
  failure?: Failure
  simDone?: { atMin: number; why: string }
  features?: Record<string, boolean>
  allLanded?: boolean
  projectTests?: { pass: boolean; detail?: string }
  acceptance?: { name: string; pass: boolean; detail?: string }[]
  noRemote?: boolean
  mainLog?: string[]
  models?: Record<
    string,
    { expected: string; ran: string[]; status?: 'ok' | 'mismatch' | 'not exercised' | 'unverified'; ok?: boolean }
  >
  sim?: { calls: number; costUsd: number; improvised: number; nudges: number; refusedAnswers: number }
  simCostUsd?: number
  scorecard?: {
    coordinators: { id: number; title?: string; intent?: string; features: string[]; landed: boolean }[]
    workers: { total: number; byCoordinator: Record<string, number> }
    plans: { coordinatorsWithPlan: number; epics: number; tasks: number }
    landings: { count: number; shas: string[]; pushed: string[]; lastAt?: number }
    timing: { firstLandingMin?: number; lastLandingMin?: number }
    usage: { byModel: Record<string, Usage>; totalCostUsd: number; cacheHitRate: number }
    questions: {
      asked: number
      withCards: number
      multi: number
      multiAnswered?: number
      answered: number
      waitSec: number[]
      texts: { id: number; from: number; kinds: string[]; text: string }[]
    }
    watchdog: { failures: number; retries: number }
    toolErrors: number
    /** Results scored before the categories have none. */
    toolErrorDetail?: {
      benign: Record<string, number>
      real: Record<string, number>
      list: { conversation: number; entry: number; tool: string; category: string; text: string }[]
    }
    checks?: { name: string; pass: boolean; gate: 'pass' | 'finding'; detail?: string }[]
  }
}

export type Decision = {
  action: 'message' | 'answer' | 'wait' | 'done'
  why?: string
  text?: string
  improvised?: boolean
  messageId?: number
  answers?: { question: string; answer: string | string[] }[]
  note?: string
}
export type SimCall = {
  at: number
  decision?: Decision
  costUsd?: number
  ms?: number
  error?: string
  applied?: string
}

export type Run = {
  result: Result
  sim?: { said: Said[]; calls: SimCall[] }
  conversations: { id: number; label?: string; title?: string; parentConversationId?: number }[]
  transcripts: number[]
  screenshots: string[]
  projectTests?: string
}

export type Entry = {
  id: number
  kind: string
  role?: string
  at?: number
  model?: string
  costUsd?: number
  tool?: string
  isError?: boolean
  text: string
  calls: { name?: string; args: string }[]
  /** An entry without a message: its data as JSON, cut. */
  data?: string
}
export type Page = { total: number; start: number; entries: Entry[] }

/** `status`: the runs in progress, compact; times in epoch ms. */
export type Status = {
  runs: {
    id: string
    scenario: string
    commit: string
    phase: string
    repeat: { index: number; total: number }
    plan?: { index: number; total: number }
    startedAt: number
    updatedAt: number
  }[]
}

/** The perf trend and one point in full, as src/perf/trend.ts makes them. */
export type { Stat, TrendPass, TrendPoint, TrendVersion } from '../../../src/perf/trend.ts'
export type PerfPoint = Omit<TrendBatch, 'passes'> & { passes: TrendPass[] }

export const PerfAction = actionRef<{ metrics: string[] }, TrendVersion[]>('bench', 'perf')
export const PerfPointAction = actionRef<{ batch: string; commit: string }, PerfPoint>('bench', 'perfPoint')
export const OverviewAction = actionRef<null, Overview>('bench', 'overview')
export const StatusAction = actionRef<null, Status>('bench', 'status')
export const LiveAction = actionRef<null, InProgress[]>('bench', 'live')
export const RunAction = actionRef<{ id: string }, Run>('bench', 'run')
export const TranscriptAction = actionRef<
  { id: string; conversation: number; before?: number },
  Page
>('bench', 'transcript')
export const ScreenshotAction = actionRef<{ id: string; name: string }, string>(
  'bench',
  'screenshot',
)
export const CancelAction = actionRef<{ id: string }, { cancelled: string; pid: number }>(
  'bench',
  'cancel',
)

export const short = (sha: string | undefined) => (sha ?? '').slice(0, 7)
export const usd = (n: number | undefined) => (n === undefined ? '–' : `$${n.toFixed(2)}`)
export const mins = (n: number | undefined) => (n === undefined ? '–' : `${n.toFixed(1)}m`)
export const pct = (n: number | undefined) => (n === undefined ? '–' : `${Math.round(n * 100)}%`)
/** Minutes and seconds, `14:05`. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const timeOfDay = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
/** `Nov 11 20:16`, the day only when it is not today. Called per row, so it reuses two formatters. */
export const when = (at: string | number | undefined) => {
  if (at === undefined) return '–'
  const d = new Date(at)
  const time = timeOfDay.format(d)
  if (d.toDateString() === new Date().toDateString()) return time
  return `${day.format(d)} ${time}`
}

/** A finished run's tone: passed, failed, or stopped by us (not Ultimate's fault). */
export type Tone = 'pass' | 'fail' | 'cancelled'
export const toneOf = (r: { pass: boolean; status: string }): Tone =>
  r.pass ? 'pass' : r.status === 'cancelled' ? 'cancelled' : 'fail'
/** What a run ended as, in one word: `pass`, or its status when that says more (`hang`, `timeout`). */
export const verdict = (r: { pass: boolean; status: string }) =>
  r.pass ? 'pass' : r.status === 'done' ? 'fail' : r.status
export const toneText: Record<Tone, string> = {
  pass: 'text-success',
  fail: 'text-error',
  cancelled: 'text-muted-foreground',
}
export const toneDot: Record<Tone, string> = {
  pass: 'bg-success',
  fail: 'bg-error',
  cancelled: 'bg-muted-foreground/40',
}
