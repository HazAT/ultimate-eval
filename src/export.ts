/**
 * The public, cleaned-up result of each finished run: `results/<id>.json`. Every field is picked by name from
 * `runs/<id>/result.json` (an allowlist): pins, outcome, check names with pass/fail and scorecard numbers. Nothing
 * free-form leaves `runs/`: no transcripts, question texts, titles, failure details, paths, hosts or URLs.
 * A scan of the output fails the whole export before anything is written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// biome-ignore lint: the stored result is untyped JSON.
type Json = any

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown) => v === true
const counts = (o: unknown) =>
  Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).flatMap(([k, n]) => (num(n) === undefined ? [] : [[k, n]])))

/** The allowlisted view of one run's result. */
export function publicResult(r: Json) {
  const p = r.pins ?? {}
  const card = r.scorecard
  const coordinators: Json[] = card?.coordinators ?? []
  const stuck = r.failure?.stuck
  return {
    id: str(r.id),
    pins: {
      ultimateCommit: str(p.ultimateCommit),
      scenario: str(p.scenario),
      scenarioSha: str(p.scenarioSha),
      setup: str(p.setup),
      setupSha: str(p.setupSha),
      families: Object.fromEntries(
        Object.entries((p.families ?? {}) as Record<string, Json>).map(([f, v]) => [f, { model: str(v?.model), thinking: str(v?.thinking) }]),
      ),
      roles: Object.fromEntries(Object.entries((p.roles ?? {}) as Record<string, unknown>).map(([role, f]) => [role, str(f)])),
      simModel: str(p.simModel),
      simEffort: str(p.simEffort),
      simPromptSha: str(p.simPromptSha),
      evalCommit: str(p.evalCommit),
    },
    pass: bool(r.pass),
    status: str(r.status),
    // The kind and where it stood, as counts: the stored detail and stuck state quote titles and questions.
    failure: r.failure
      ? {
          reason: str(r.failure.reason),
          atMin: num(r.failure.atMin),
          stuck: stuck && {
            busy: Array.isArray(stuck.busy) ? stuck.busy.length : undefined,
            open: Array.isArray(stuck.open) ? stuck.open.length : undefined,
            lastProgressMin: num(stuck.lastProgressMin),
          },
        }
      : undefined,
    minutes: num(r.minutes),
    startupSec: num(r.startupSec),
    costUsd: Math.round(((num(card?.usage?.totalCostUsd) ?? 0) + (num(r.sim?.costUsd) ?? num(r.simCostUsd) ?? 0)) * 100) / 100,
    features: Object.fromEntries(Object.entries((r.features ?? {}) as Record<string, unknown>).map(([f, ok]) => [f, bool(ok)])),
    acceptance: ((r.acceptance ?? []) as Json[]).map((c) => ({ name: str(c.name), pass: bool(c.pass) })),
    projectTests: r.projectTests ? { pass: bool(r.projectTests.pass) } : undefined,
    allLanded: r.allLanded === undefined ? undefined : bool(r.allLanded),
    noRemote: r.noRemote === undefined ? undefined : bool(r.noRemote),
    models: Object.fromEntries(
      Object.entries((r.models ?? {}) as Record<string, Json>).map(([role, m]) => [
        role,
        { expected: str(m?.expected), ran: ((m?.ran ?? []) as unknown[]).flatMap((x) => str(x) ?? []), status: str(m?.status) },
      ]),
    ),
    answerShape: str(r.answerShape),
    sim: r.sim && {
      calls: num(r.sim.calls),
      costUsd: num(r.sim.costUsd),
      improvised: num(r.sim.improvised),
      nudges: num(r.sim.nudges),
      refusedAnswers: num(r.sim.refusedAnswers),
    },
    scorecard: card && {
      coordinators: { started: coordinators.length, landed: coordinators.filter((c) => c?.landed === true).length },
      workers: { total: num(card.workers?.total) },
      plans: counts(card.plans),
      landings: { count: num(card.landings?.count), pushed: Array.isArray(card.landings?.pushed) ? card.landings.pushed.length : undefined },
      timing: counts(card.timing),
      usage: {
        byModel: Object.fromEntries(Object.entries((card.usage?.byModel ?? {}) as Record<string, unknown>).map(([m, u]) => [m, counts(u)])),
        totalCostUsd: num(card.usage?.totalCostUsd),
        cacheHitRate: num(card.usage?.cacheHitRate),
      },
      questions: card.questions && {
        asked: num(card.questions.asked),
        withCards: num(card.questions.withCards),
        multi: num(card.questions.multi),
        multiAnswered: num(card.questions.multiAnswered),
        answered: num(card.questions.answered),
        waitSec: ((card.questions.waitSec ?? []) as unknown[]).flatMap((s) => num(s) ?? []),
      },
      watchdog: counts(card.watchdog),
      toolErrors: num(card.toolErrors),
      toolErrorDetail: { real: counts(card.toolErrorDetail?.real), benign: counts(card.toolErrorDetail?.benign) },
      checks: ((card.checks ?? []) as Json[]).map((c) => ({ name: str(c.name), pass: bool(c.pass), gate: str(c.gate) })),
    },
  }
}

/** What must never be published: hosts, paths, addresses, emails. `tail` only at a word start (tailnet names), since `detail` is a feature. */
const FORBIDDEN: [string, RegExp][] = [
  ['@', /@/],
  ['/home/', /\/home\//],
  ['tail', /\btail/i],
  ['.ts.net', /\.ts\.net/i],
  ['127.0.0.1', /127\.0\.0\.1/],
  ['localhost', /localhost/i],
  ['email', /[\w.+-]+\s*(@|\(at\)|\[at\])\s*[\w-]+\.[\w.]+/i],
]

/** The forbidden patterns found in a text. */
export const scan = (text: string) => FORBIDDEN.flatMap(([name, re]) => (re.test(text) ? [name] : []))

/** Results of runs that finished: not cancelled, not still running (no result yet), with pins. */
export function finishedResults(runsDir: string): Json[] {
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, 'result.json')))
    .map((name) => JSON.parse(readFileSync(join(runsDir, name, 'result.json'), 'utf8')))
    .filter((r) => r.pins && r.finishedAt && r.status !== 'cancelled')
}

/** Writes `<outDir>/<id>.json` for every finished run; throws, writing nothing, when any output trips the scan. */
export function exportResults(runsDir: string, outDir: string) {
  const files = finishedResults(runsDir).map((r) => {
    const out = publicResult(r)
    return { name: `${out.id}.json`, text: `${JSON.stringify(out, null, 2)}\n` }
  })
  const bad = files.flatMap((f) => {
    const hits = scan(f.text)
    return hits.length ? [`${f.name}: ${hits.join(', ')}`] : []
  })
  if (bad.length) throw new Error(`export refused, forbidden content in:\n${bad.join('\n')}`)
  mkdirSync(outDir, { recursive: true })
  for (const f of files) writeFileSync(join(outDir, f.name), f.text)
  return files.length
}
