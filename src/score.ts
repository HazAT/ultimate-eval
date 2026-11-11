/**
 * The scorecard, from what a run collected over the API: every conversation's summary and history, and the root's
 * Messages log. Pure, so it is tested on fixtures.
 */
import type { Entry, Message, Summary } from './api.ts'

export type Collected = {
  conversations: Summary[]
  histories: Record<number, Entry[]>
  board: { messages: Message[] }
  ultimate: number
  firstPromptAt: number
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
    answered: number
    waitSec: number[]
    texts: { id: number; from: number | string; kinds: string[]; text: string }[]
  }
  watchdog: { failures: number; retries: number }
  toolErrors: number
}

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

/** The role a conversation plays, from its label and its place in the tree. */
export function roleOf(c: Summary, ultimate: number, coordinators: Set<number>) {
  if (c.id === ultimate) return 'ultimate'
  if (coordinators.has(c.id)) return 'coordinator'
  if (c.label === 'lander') return 'lander'
  if (c.parentConversationId && coordinators.has(c.parentConversationId)) return c.label ?? 'child'
  return c.label ?? 'other'
}

export function score(data: Collected, featureWords: Record<string, RegExp>): Scorecard {
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
  let toolErrors = 0
  for (const [id, entries] of Object.entries(data.histories)) {
    const summary = byId.get(Number(id))
    const role = summary ? roleOf(summary, data.ultimate, coordinatorIds) : 'other'
    for (const entry of entries) {
      if (entry.kind === 'watchdog.failure') failures++
      if (entry.kind.startsWith('watchdog.') && /retry|continu/i.test(entry.kind + textOf(entry))) retries++
      const message = entry.model?.[0]
      if (message?.role === 'toolResult' && (message as { isError?: boolean }).isError) toolErrors++
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
  const replyAt = new Map(
    data.board.messages.filter((m) => m.from === 'user' && m.re).map((m) => [m.re!, m.at]),
  )
  const waitSec = toUser.flatMap((m) =>
    replyAt.has(m.id) ? [Math.round((replyAt.get(m.id)! - m.at) / 1000)] : [],
  )

  const landingTimes = notes.map((n) => n.model?.[0]?.timestamp ?? 0).filter(Boolean)
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
      multi: toUser.filter((m) => m.questions?.some((q) => q.kind === 'multi')).length,
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
    toolErrors,
  }
}

/** The text of an assistant answer, for transcripts. */
export const answerText = textOf
