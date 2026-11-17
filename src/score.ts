/**
 * The scorecard, from what a run collected over the API: every conversation's summary and history, and the root's
 * Messages log. Pure, so it is tested on fixtures.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { heardAnswers } from './api.ts'
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
  /** The automations the run's agents created (the built-in dream ones left out), read from the stopped home. */
  automations?: Automation[]
}

/** What the scorecard needs of an automation record (automations/types.ts in Ultimate). */
export type Automation = {
  id: string
  name: string
  createdAt: number
  schedule?: { kind: string; time?: string; expr?: string; ms?: number }
  prompt?: string
  subscribers: (number | string)[]
  runs: { id: string; firedAt: number; conversationId?: number; status: string }[]
  fires: number
  lastFireAt?: number
}

export type RoleStats = {
  turns: number
  tools: Record<string, number>
  /** Calls made inside codemode scripts, from each codemode result's `details.calls`. */
  nested: Record<string, number>
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
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
  coordinators: {
    id: number
    title?: string
    intent?: string
    features: string[]
    landed: boolean
    /** It made no change to land: no commit, no `workspace submit`, no lander report, in it or its subagents. */
    nothingToLand?: true
  }[]
  featuresWithCoordinator: Record<string, number[]>
  workers: { total: number; byCoordinator: Record<number, number> }
  plans: { coordinatorsWithPlan: number; epics: number; tasks: number }
  landings: { count: number; shas: string[]; pushed: string[]; lastAt?: number }
  timing: { firstLandingMin?: number; lastLandingMin?: number }
  usage: { byModel: Record<string, ModelUsage>; totalCostUsd: number; cacheHitRate: number }
  modelsByRole: Record<string, string[]>
  /** Per role: model turns, top-level tool calls and nested codemode calls by name, and tokens. */
  byRole: Record<string, RoleStats>
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
    /** Each real error. */
    list: { conversation: number; entry: number; tool: string; category: RealError; text: string }[]
  }
  /** Automations the agents created (dream's built-in ones left out), how many fired, and their fires. */
  automations: { created: number; fired: number; fires: number }
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
  /** An automation was created, it fired, and something the user sees came after its first fire. */
  reminder?: { gate: Gate }
  /**
   * @ultimate told `project` (`ultimate.tell`), the tell was delivered and answered, and after the answer the user saw
   * text matching `heard` (a case-insensitive regular expression).
   */
  tell?: { project: string; heard: string; gate: Gate }
  /** Every branch must land, but none is fine: the task is small enough for @ultimate to do alone. */
  branchOptional?: boolean
}

/** A reply-expected message nobody answered, and the same text sent twice, on one Messages log. */
export function boardChecks(board: { messages: Message[] }, prefix = ''): Check[] {
  const pending = board.messages.filter((m) => m.reply && ['sent', 'delivered', 'failed'].includes(m.state))
  const firstOf = new Map<string, number>()
  const twice: string[] = []
  for (const m of board.messages) {
    const key = `${m.from}|${m.to}|${m.text.trim()}`
    if (firstOf.has(key)) twice.push(`${m.id} repeats ${firstOf.get(key)}`)
    else firstOf.set(key, m.id)
  }
  return [
    {
      name: `${prefix}every reply-expected message answered`,
      pass: !pending.length,
      gate: 'finding',
      detail: pending.length
        ? pending.map((m) => `${m.id} ${m.from}→${m.to} ${m.state}`).join('; ')
        : `${board.messages.filter((m) => m.reply).length} answered`,
    },
    {
      name: `${prefix}no message sent twice`,
      pass: !twice.length,
      gate: 'finding',
      detail: twice.length ? twice.join('; ') : `${board.messages.length} messages`,
    },
  ]
}

/** The `warn` and `error` lines of a supervisor log (JSON lines). */
export function logProblems(text: string) {
  return text.split('\n').filter((line) => {
    try {
      return ['warn', 'error'].includes((JSON.parse(line) as { level?: string }).level ?? '')
    } catch {
      return false
    }
  })
}

/**
 * The other side of a tell, all findings: the peer project `name` received one message from another project, answered
 * it, asked its own user nothing (nobody is there), left its board clean, and its supervisor logged no problem.
 */
export function peerChecks(name: string, board: { messages: Message[] }, supervisorLog: string): Check[] {
  const received = board.messages.filter((m) => m.from === 'remote' && m.re === undefined)
  const asked = board.messages.filter((m) => m.to === 'user' && m.reply)
  const problems = logProblems(supervisorLog)
  return [
    {
      name: `${name}: received one tell`,
      pass: received.length === 1,
      gate: 'finding',
      detail: received.map((m) => `${m.id} ${m.state}`).join('; ') || 'none',
    },
    {
      name: `${name}: answered the tell`,
      pass: received.length > 0 && received.every((m) => m.state === 'answered'),
      gate: 'finding',
      detail: received.map((m) => `${m.id} ${m.state}`).join('; ') || 'none',
    },
    {
      name: `${name}: asked its user nothing`,
      pass: !asked.length,
      gate: 'finding',
      detail: asked.map((m) => `${m.id}: ${m.text.slice(0, 120)}`).join('; ') || 'no cards',
    },
    ...boardChecks(board, `${name}: `),
    {
      name: `${name}: supervisor log clean`,
      pass: !problems.length,
      gate: 'finding',
      detail: problems.length ? problems.slice(0, 3).map((l) => l.slice(0, 200)).join('; ') : 'no warn or error lines',
    },
  ]
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
export function errorCategory(tool: string, text: string, command = ''): BenignError | RealError {
  if (tool === 'bash' && /exited with code 143\b/.test(text)) return 'killed'
  if ((tool === 'browser' || tool === 'screenshot') && /ERR_CONNECTION_REFUSED/.test(text)) return 'serverNotUp'
  // curl's "failed to connect"; another command exiting 7 is a real failure.
  if (tool === 'bash' && /exited with code 7\b/.test(text) && /\bcurl\b/.test(command)) return 'serverNotUp'
  if (/Worktree is dirty/.test(text)) return 'dirtyWorktree'
  if (/ENOENT/.test(text)) return 'enoent'
  if (tool === 'bash' && /exited with code \d+/.test(text)) return 'bashExit'
  return 'unknown'
}
const BENIGN = new Set<string>(['killed', 'serverNotUp'])
/** Start and end of a long text: a command's output leads, its exit code ends it. */
const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 100)} … ${text.slice(-130)}` : text)

/** A bash call that commits: `git commit` (options such as `-C dir` or `-c k=v` between), not `git log --grep=commit`. */
export const commits = (call: { name?: string; arguments?: Record<string, unknown> }) =>
  call.name === 'bash' &&
  /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/.test(String(call.arguments?.command ?? ''))

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

/**
 * Whether a coordinator made changes that need landing: a commit, a `workspace submit` or a lander report in its
 * history or a subagent's. A read-only check (run 20261116t2152-7233760-sc2r, #632) has none and nothing to land.
 */
export function madeChanges(data: Pick<Collected, 'conversations' | 'histories'>, id: number): boolean {
  const children = data.conversations.filter((c) => c.parentConversationId === id && c.label !== 'lander')
  const changed = (data.histories[id] ?? []).some(
    (e) =>
      e.kind === 'workspaces.lander-report' ||
      toolCalls(e).some((call) => commits(call) || (call.name === 'workspace' && call.arguments?.action === 'submit')),
  )
  return changed || children.some((c) => madeChanges(data, c.id))
}

/** Every coordinator that made changes landed; one with nothing to land needs no landing. */
export const everyLanded = (coordinators: Scorecard['coordinators']) =>
  coordinators.every((c) => c.landed || c.nothingToLand)

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
    const landed = landedFrom.has(branch)
    return {
      id: branch,
      title,
      intent,
      features: (() => {
        const fromIntent = featuresOf(intent ?? '', featureWords)
        return fromIntent.length ? fromIntent : featuresOf(title ?? '', featureWords)
      })(),
      landed,
      ...(landed || madeChanges(data, branch) ? {} : { nothingToLand: true as const }),
    }
  })
  const featuresWithCoordinator: Record<string, number[]> = {}
  for (const name of Object.keys(featureWords))
    featuresWithCoordinator[name] = coordinators
      .filter((c) => !c.nothingToLand && c.features.includes(name))
      .map((c) => c.id)

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
  const byRole: Record<string, RoleStats> = {}
  const bump = (counts: Record<string, number>, name: string) => (counts[name] = (counts[name] ?? 0) + 1)
  let failures = 0
  let retries = 0
  const benign: Scorecard['toolErrorDetail']['benign'] = {}
  const real: Scorecard['toolErrorDetail']['real'] = {}
  const realList: Scorecard['toolErrorDetail']['list'] = []
  let firstCommitAt = Infinity
  for (const [id, entries] of Object.entries(data.histories)) {
    const summary = byId.get(Number(id))
    const role = summary ? roleOf(summary, data.ultimate, coordinatorIds, data.agents?.[Number(id)]) : 'unknown'
    const commandOf = new Map<string, string>()
    const stats = () =>
      (byRole[role] ??= { turns: 0, tools: {}, nested: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    for (const entry of entries) {
      for (const call of toolCalls(entry) as { id?: string; arguments?: { command?: unknown } }[])
        if (call.id) commandOf.set(call.id, String(call.arguments?.command ?? ''))
      if (entry.kind === 'watchdog.failure') failures++
      if (entry.kind.startsWith('watchdog.') && /retry|continu/i.test(entry.kind + textOf(entry))) retries++
      const message = entry.model?.[0]
      if (message?.role === 'toolResult' && (message as { toolName?: string }).toolName === 'codemode') {
        const calls = (message as { details?: { calls?: { name?: string }[] } }).details?.calls
        for (const call of Array.isArray(calls) ? calls : []) if (call.name) bump(stats().nested, call.name)
      }
      if (message?.role === 'toolResult' && (message as { isError?: boolean }).isError) {
        const tool = (message as { toolName?: string }).toolName ?? '?'
        const text = resultText(message.content)
        const call = (message as { toolCallId?: string }).toolCallId
        const category = errorCategory(tool, text, call ? commandOf.get(call) : undefined)
        if (BENIGN.has(category)) benign[category as BenignError] = (benign[category as BenignError] ?? 0) + 1
        else {
          real[category as RealError] = (real[category as RealError] ?? 0) + 1
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
      const s = stats()
      s.turns++
      for (const call of toolCalls(entry)) if (call.name) bump(s.tools, call.name)
      s.input += message.usage.input
      s.output += message.usage.output
      s.cacheRead += message.usage.cacheRead
      s.cacheWrite += message.usage.cacheWrite
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
    // The lander's reports in each submitter's history: a lander check that failed (`check failed twice: <command>`,
    // as the lander words it), then a later landing of the same submitter.
    const failed = Object.values(data.histories).flatMap((entries) => {
      const reports = entries.filter((e) => e.kind === 'workspaces.lander-report')
      return reports.flatMap((e, i) => {
        const outcome = (e.data as { outcome?: { outcome?: string; reason?: string } } | undefined)?.outcome
        const landedLater = reports
          .slice(i + 1)
          .some((l) => (l.data as { outcome?: { outcome?: string } }).outcome?.outcome === 'landed')
        return outcome?.outcome === 'failed' && /^check failed/.test(outcome.reason ?? '') && landedLater
          ? [`#${e.conversationId}: ${outcome.reason}`]
          : []
      })
    })
    const allLanded = coordinators.length > 0 && everyLanded(coordinators)
    checks.push({
      name: 'landed after a failed landing check',
      pass: failed.length > 0 && allLanded,
      gate: expect.landFailedFirst.gate,
      detail: failed.length ? failed.slice(0, 3).join('; ') : 'no landing failed a check',
    })
  }

  // The Messages log at the end: a reply-expected message nobody answered, and the same text sent twice.
  checks.push(...boardChecks(data.board))

  if (expect.tell) {
    const { project, gate } = expect.tell
    const told = data.board.messages.filter(
      (m) => m.from === data.ultimate && m.to === 'remote' && m.remote?.project === project,
    )
    const delivered = told.filter((m) => m.remote?.id !== undefined && m.state !== 'failed')
    // A failed or stopped tell gets a reply too, its failure: only replies to tells that settled answered count.
    const answered = told.filter((m) => m.state === 'answered')
    const answers = data.board.messages.filter(
      (m) => m.from === 'remote' && !m.interim && answered.some((t) => t.id === m.re),
    )
    const answeredAt = Math.min(...answers.map((m) => m.at))
    const heard = new RegExp(expect.tell.heard, 'i')
    const seen = [
      ...data.board.messages.filter((m) => m.to === 'user' && m.at >= answeredAt).map((m) => m.text),
      ...heardAnswers(data.histories[data.ultimate] ?? [], 0, data.board, data.ultimate, false, textOf)
        .answers.filter((a) => (a.at ?? 0) >= answeredAt)
        .map((a) => a.text),
    ]
    checks.push({
      name: `told ${project}, delivered`,
      pass: delivered.length > 0,
      gate,
      detail: told.map((m) => `${m.id} ${m.state}${m.remote?.id !== undefined ? ` as ${m.remote.id}` : ''}`).join('; ') || 'no tell',
    })
    checks.push({
      name: `${project} answered the tell`,
      pass: answers.length > 0,
      gate,
      detail: answers.length ? `answer ${answers.map((m) => m.id).join(', ')}` : 'no answer',
    })
    checks.push({
      name: `the user heard ${project}'s answer`,
      pass: answers.length > 0 && seen.some((text) => heard.test(text)),
      gate,
      detail: !answers.length ? 'no answer' : `${seen.length} messages after it, ${seen.filter((t) => heard.test(t)).length} name it`,
    })
  }

  const automations = data.automations ?? []
  if (expect.reminder) {
    const fired = automations.filter((a) => a.fires > 0)
    const firedAt = Math.min(...fired.flatMap((a) => (a.lastFireAt ? [a.lastFireAt] : a.runs.map((r) => r.firedAt))))
    // What the user sees after the fire: a message to the user, or one of @ultimate's own answers.
    const toUserAfter = data.board.messages.filter((m) => m.to === 'user' && m.at >= firedAt)
    const heardAfter = heardAnswers(data.histories[data.ultimate] ?? [], 0, data.board, data.ultimate, false, textOf)
      .answers.filter((a) => (a.at ?? 0) >= firedAt)
    const reached = toUserAfter.length > 0 || heardAfter.length > 0
    const describe = (a: Automation) =>
      `${a.id} ${a.schedule ? `${a.schedule.kind} ${a.schedule.time ?? a.schedule.expr ?? a.schedule.ms ?? ''}`.trim() : 'no schedule'}, ${a.prompt ? 'prompt run' : `wakes ${a.subscribers.join(', ')}`}, created ${minutes(a.createdAt)} min, ${a.fires} fires`
    checks.push({
      name: 'an automation was created',
      pass: automations.length > 0,
      gate: expect.reminder.gate,
      detail: automations.length ? automations.map(describe).join('; ') : 'none',
    })
    checks.push({
      name: 'the automation fired',
      pass: fired.length > 0,
      gate: expect.reminder.gate,
      detail: fired.length ? `first fire at ${minutes(firedAt)} min` : 'no fire',
    })
    checks.push({
      name: 'the user heard from Ultimate after the fire',
      pass: fired.length > 0 && reached,
      gate: expect.reminder.gate,
      detail: !fired.length
        ? 'no fire'
        : reached
          ? `${toUserAfter.length} messages and ${heardAfter.length} @ultimate answers after it`
          : 'nothing the user sees after the fire',
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
    byRole,
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
    automations: {
      created: automations.length,
      fired: automations.filter((a) => a.fires > 0).length,
      fires: automations.reduce((n, a) => n + a.fires, 0),
    },
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
