/**
 * The scorecard, from what a run collected over the API: every conversation's summary and history, and the root's
 * Messages log. Pure, so it is tested on fixtures.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Entry, Message, Summary } from './api.ts'

export type Collected = {
  conversations: Summary[]
  histories: Record<number, Entry[]>
  board: { messages: Message[] }
  ultimate: number
  firstPromptAt: number
  /**
   * The agent definition each conversation was configured from (its `ultimate.agent-profile`), read from the stopped
   * home. A display label can be anything; this cannot. Ad-hoc agents have none.
   */
  agents?: Record<number, string>
}

type ModelUsage = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export type Scorecard = {
  coordinators: { id: number; title?: string; intent?: string; features: string[]; landed: boolean }[]
  featuresWithCoordinator: Record<string, number[]>
  workers: { total: number; byCoordinator: Record<number, number> }
  plans: { coordinatorsWithPlan: number; epics: number; tasks: number }
  landings: { count: number; shas: string[]; pushed: string[]; lastAt?: number }
  timing: { firstLandingMin?: number; lastLandingMin?: number }
  usage: { byModel: Record<string, ModelUsage>; totalCostUsd: number; cacheHitRate: number }
  modelsByRole: Record<string, string[]>
  questions: {
    asked: number
    withCards: number
    multi: number
    multiAnswered: number
    answered: number
    waitSec: number[]
    texts: { id: number; from: number | string; kinds: string[]; text: string }[]
  }
  watchdog: { failures: number; retries: number }
  /** Real tool errors: everything but the known-benign categories. */
  toolErrors: number
  toolErrorDetail: {
    benign: Partial<Record<BenignError, number>>
    real: Partial<Record<RealError, number>>
    /** Each real error, up to 50. */
    list: { conversation: number; entry: number; tool: string; category: RealError; text: string }[]
  }
  /** Hard checks: the scenario's expectations and the extra-coordinator check. A failed `finding` is recorded only. */
  checks: Check[]
}

export type Gate = 'pass' | 'finding'
export type Check = { name: string; pass: boolean; gate: Gate; detail?: string }

/**
 * What a scenario expects of a run beyond its hidden spec (`scenarios/<name>/expect.json`), each gated: `pass` fails
 * the run, `finding` records it.
 */
export type Expect = {
  /** A reply-expected card to the user, with a question of `kind` when given. */
  card?: { kind?: string; gate: Gate }
  /** A card to the user before the first commit anywhere. */
  askedFirst?: { gate: Gate }
  /** A landing failed on a lander check (not a merge conflict), and everything still landed. */
  landFailedFirst?: { gate: Gate }
  /** Project paths unchanged on main against the fixture commit; checked by the runner on the project. */
  untouched?: { paths: string[]; gate: Gate }
}

/**
 * Benign: the agent killing its own dev server (bash exit 143), or a browser or curl (exit 7) reaching for it before
 * it was up. Real: a dirty worktree (an unresolved merge on submit), a missing file, any other failed command, and
 * anything else (a refused tool call, a script error).
 */
export type BenignError = 'killed' | 'serverNotUp'
export type RealError = 'dirtyWorktree' | 'enoent' | 'bashExit' | 'unknown'

const resultText = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n')
      : ''

/** The category of one failed tool result. */
export function errorCategory(tool: string, text: string): BenignError | RealError {
  if (tool === 'bash' && /exited with code 143\b/.test(text)) return 'killed'
  if ((tool === 'browser' || tool === 'screenshot') && /ERR_CONNECTION_REFUSED/.test(text)) return 'serverNotUp'
  if (tool === 'bash' && /exited with code 7\b/.test(text)) return 'serverNotUp'
  if (/Worktree is dirty/.test(text)) return 'dirtyWorktree'
  if (/ENOENT/.test(text)) return 'enoent'
  if (tool === 'bash' && /exited with code \d+/.test(text)) return 'bashExit'
  return 'unknown'
}
const BENIGN = new Set<string>(['killed', 'serverNotUp'])
/** Start and end of a long text: a command's output leads, its exit code ends it. */
const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 100)} … ${text.slice(-130)}` : text)

/** A bash call that commits. */
const commits = (call: { name?: string; arguments?: Record<string, unknown> }) =>
  call.name === 'bash' && /\bgit\b[^\n;&|]*\bcommit\b/.test(String(call.arguments?.command ?? ''))

const textOf = (entry: Entry) => {
  const content = entry.model?.[0]?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('\n')
  return ''
}

const toolCalls = (entry: Entry) => {
  const content = entry.model?.[0]?.content
  return Array.isArray(content)
    ? (content as { type: string; name?: string; arguments?: Record<string, unknown> }[]).filter(
        (c) => c.type === 'toolCall',
      )
    : []
}

/** A lander's landing note, as Ultimate's own lineage memory tells it from an ordinary note (`source`, `sha`). */
export const isLanding = (e: Entry) => {
  const data = e.data as { source?: string; sha?: unknown } | undefined
  return e.kind === 'lineage.note' && data?.source === 'lander' && typeof data.sha === 'string'
}

/** The features a coordinator works on, by words in its intent and title. */
export function featuresOf(text: string, words: Record<string, RegExp>) {
  return Object.entries(words)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name)
}

/**
 * The role a conversation plays: @ultimate, a coordinator (a branch), the lander, else the definition it was configured
 * from. Without one (an ad-hoc agent) it is `unknown`, never guessed from its display label.
 */
export function roleOf(c: Summary, ultimate: number, coordinators: Set<number>, agent?: string) {
  if (c.id === ultimate) return 'ultimate'
  if (coordinators.has(c.id)) return 'coordinator'
  if (c.label === 'lander') return 'lander'
  return agent ?? 'unknown'
}

export function score(data: Collected, featureWords: Record<string, RegExp>, expect: Expect = {}): Scorecard {
  const minutes = (at: number) => Math.round(((at - data.firstPromptAt) / 60000) * 10) / 10
  const root = data.histories[1] ?? []
  const branched = root.filter((e) => e.kind === 'lineage.branched')
  const notes = root.filter((e) => isLanding(e))
  const landedFrom = new Set(notes.map((n) => (n.data as { from?: number }).from))
  const coordinatorIds = new Set(branched.map((e) => (e.data as { branch: number }).branch))
  const byId = new Map(data.conversations.map((c) => [c.id, c]))

  const coordinators = branched.map((e) => {
    const { branch, intent } = e.data as { branch: number; intent?: string }
    const title = byId.get(branch)?.title
    return {
      id: branch,
      title,
      intent,
      features: (() => {
        const fromIntent = featuresOf(intent ?? '', featureWords)
        return fromIntent.length ? fromIntent : featuresOf(title ?? '', featureWords)
      })(),
      landed: landedFrom.has(branch),
    }
  })
  const featuresWithCoordinator: Record<string, number[]> = {}
  for (const name of Object.keys(featureWords))
    featuresWithCoordinator[name] = coordinators.filter((c) => c.features.includes(name)).map((c) => c.id)

  const byCoordinator: Record<number, number> = {}
  for (const c of data.conversations)
    if (c.parentConversationId && coordinatorIds.has(c.parentConversationId) && c.label !== 'lander')
      byCoordinator[c.parentConversationId] = (byCoordinator[c.parentConversationId] ?? 0) + 1

  let coordinatorsWithPlan = 0
  let epics = 0
  let tasks = 0
  for (const id of coordinatorIds) {
    let planned = false
    for (const entry of data.histories[id] ?? [])
      for (const call of toolCalls(entry)) {
        if (call.name !== 'plan') continue
        if (call.arguments?.action === 'create') {
          epics++
          planned = true
        }
        if (call.arguments?.action === 'add') tasks++
      }
    if (planned) coordinatorsWithPlan++
  }

  const byModel: Record<string, ModelUsage> = {}
  const modelsByRole: Record<string, Set<string>> = {}
  let failures = 0
  let retries = 0
  const benign: Scorecard['toolErrorDetail']['benign'] = {}
  const real: Scorecard['toolErrorDetail']['real'] = {}
  const realList: Scorecard['toolErrorDetail']['list'] = []
  let firstCommitAt = Infinity
  for (const [id, entries] of Object.entries(data.histories)) {
    const summary = byId.get(Number(id))
    const role = summary ? roleOf(summary, data.ultimate, coordinatorIds, data.agents?.[Number(id)]) : 'unknown'
    for (const entry of entries) {
      if (entry.kind === 'watchdog.failure') failures++
      if (entry.kind.startsWith('watchdog.') && /retry|continu/i.test(entry.kind + textOf(entry))) retries++
      const message = entry.model?.[0]
      if (message?.role === 'toolResult' && (message as { isError?: boolean }).isError) {
        const tool = (message as { toolName?: string }).toolName ?? '?'
        const text = resultText(message.content)
        const category = errorCategory(tool, text)
        if (BENIGN.has(category)) benign[category as BenignError] = (benign[category as BenignError] ?? 0) + 1
        else {
          real[category as RealError] = (real[category as RealError] ?? 0) + 1
          if (realList.length < 50)
            realList.push({
              conversation: Number(id),
              entry: entry.id,
              tool,
              category: category as RealError,
              text: clip(text.replace(/\s+/g, ' ').trim()),
            })
        }
      }
      if (message?.role === 'assistant' && message.timestamp && toolCalls(entry).some(commits))
        firstCommitAt = Math.min(firstCommitAt, message.timestamp)
      if (message?.role !== 'assistant' || !message.usage) continue
      const name = `${message.provider}/${message.model}`
      ;(modelsByRole[role] ??= new Set()).add(name)
      const u = (byModel[name] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })
      u.calls++
      u.input += message.usage.input
      u.output += message.usage.output
      u.cacheRead += message.usage.cacheRead
      u.cacheWrite += message.usage.cacheWrite
      u.costUsd += message.usage.cost?.total ?? 0
    }
  }
  const sum = (key: keyof ModelUsage) => Object.values(byModel).reduce((n, u) => n + u[key], 0)
  const prompt = sum('input') + sum('cacheRead') + sum('cacheWrite')

  const toUser = data.board.messages.filter((m) => m.to === 'user' && m.reply)
  const isMulti = (m: (typeof toUser)[number]) => !!m.questions?.some((q) => q.kind === 'multi')
  const replyAt = new Map(
    data.board.messages.filter((m) => m.from === 'user' && m.re).map((m) => [m.re!, m.at]),
  )
  const waitSec = toUser.flatMap((m) =>
    replyAt.has(m.id) ? [Math.round((replyAt.get(m.id)! - m.at) / 1000)] : [],
  )

  const landingTimes = notes.map((n) => n.model?.[0]?.timestamp ?? 0).filter(Boolean)

  const checks: Check[] = []
  const extra = coordinators.filter((c) => !c.features.length)
  checks.push({
    name: 'every coordinator works on a feature',
    pass: !extra.length,
    gate: 'finding',
    ...(extra.length ? { detail: extra.map((c) => `#${c.id} ${c.intent ?? c.title ?? ''}`.trim()).join('; ') } : {}),
  })
  if (expect.card) {
    const { kind } = expect.card
    const asked = toUser.filter((m) => !kind || m.questions?.some((q) => q.kind === kind))
    checks.push({
      name: kind ? `asked a ${kind} card` : 'asked a card',
      pass: asked.length > 0,
      gate: expect.card.gate,
      detail: asked.length ? `card ${asked[0]!.id}` : `${toUser.length} cards, none ${kind ?? ''}`.trim(),
    })
  }
  if (expect.askedFirst) {
    const firstAsk = Math.min(...toUser.map((m) => m.at))
    const firstChange = Math.min(firstCommitAt, ...landingTimes)
    checks.push({
      name: 'asked before the first commit',
      pass: firstAsk < firstChange,
      gate: expect.askedFirst.gate,
      detail: `first card ${Number.isFinite(firstAsk) ? `at ${minutes(firstAsk)} min` : 'never'}, first commit ${Number.isFinite(firstChange) ? `at ${minutes(firstChange)} min` : 'never'}`,
    })
  }
  if (expect.landFailedFirst) {
    // The lander's reports in each submitter's history: a failure other than a merge conflict is a failed check.
    const failed = Object.values(data.histories)
      .flat()
      .flatMap((e) => {
        const outcome = (e.data as { outcome?: { outcome?: string; reason?: string } } | undefined)?.outcome
        return e.kind === 'workspaces.lander-report' && outcome?.outcome === 'failed' && !/conflict/i.test(outcome.reason ?? '')
          ? [`#${e.conversationId}: ${outcome.reason}`]
          : []
      })
    const allLanded = coordinators.length > 0 && coordinators.every((c) => c.landed)
    checks.push({
      name: 'landed after a failed landing check',
      pass: failed.length > 0 && allLanded,
      gate: expect.landFailedFirst.gate,
      detail: failed.length ? failed.slice(0, 3).join('; ') : 'no landing failed a check',
    })
  }

  return {
    coordinators,
    featuresWithCoordinator,
    workers: { total: Object.values(byCoordinator).reduce((a, b) => a + b, 0), byCoordinator },
    plans: { coordinatorsWithPlan, epics, tasks },
    landings: {
      count: notes.length,
      shas: notes.map((n) => (n.data as { sha: string }).sha),
      pushed: notes.flatMap((n) => {
        const pushed = (n.data as { pushed?: string }).pushed
        return pushed ? [pushed] : []
      }),
      ...(landingTimes.length ? { lastAt: Math.max(...landingTimes) } : {}),
    },
    timing: landingTimes.length
      ? {
          firstLandingMin: minutes(Math.min(...landingTimes)),
          lastLandingMin: minutes(Math.max(...landingTimes)),
        }
      : {},
    usage: {
      byModel,
      totalCostUsd: Math.round(sum('costUsd') * 100) / 100,
      cacheHitRate: prompt ? Math.round((sum('cacheRead') / prompt) * 1000) / 1000 : 0,
    },
    modelsByRole: Object.fromEntries(Object.entries(modelsByRole).map(([k, v]) => [k, [...v]])),
    questions: {
      asked: toUser.length,
      withCards: toUser.filter((m) => m.questions?.length).length,
      multi: toUser.filter(isMulti).length,
      multiAnswered: toUser.filter((m) => isMulti(m) && m.state === 'answered').length,
      answered: toUser.filter((m) => m.state === 'answered').length,
      waitSec,
      texts: toUser.map((m) => ({
        id: m.id,
        from: m.from,
        kinds: (m.questions ?? []).map((q) => q.kind),
        text: m.text.slice(0, 300),
      })),
    },
    watchdog: { failures, retries },
    toolErrors: Object.values(real).reduce((a, b) => a + b, 0),
    toolErrorDetail: { benign, real, list: realList },
    checks,
  }
}

/** A scenario's expectations, `{}` without an `expect.json`. */
export const readExpect = (scenarioDir: string): Expect => {
  const path = join(scenarioDir, 'expect.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Expect) : {}
}

/** A failed check gated `pass`: it fails the run. */
export const gateFailed = (card: Pick<Scorecard, 'checks'>) => card.checks.some((c) => c.gate === 'pass' && !c.pass)

/** Failed checks gated `finding`: what a person should look at, though the run may pass. */
export const findings = (card: Pick<Scorecard, 'checks'>) => card.checks.filter((c) => c.gate === 'finding' && !c.pass)

/** The text of an assistant answer, for transcripts. */
export const answerText = textOf
