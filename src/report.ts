/** The matrix: runs grouped by setup (commit × model setup × scenario), with passes/N and median time and cost. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleStats } from './score.ts'

export type RunResult = {
  id: string
  pass: boolean
  status: string
  minutes?: number
  pins: { ultimateCommit: string; setup: string; scenario: string; scenarioSha: string; simPromptSha: string }
  features?: Record<string, boolean>
  scorecard?: {
    usage: { totalCostUsd: number }
    coordinators: unknown
    workers: { total: number }
    questions?: { multi: number; multiAnswered?: number }
    /** Real tool errors (before categories, every error). */
    toolErrors?: number
    checks?: { name: string; pass: boolean; gate: 'pass' | 'finding'; detail?: string }[]
    byRole?: Record<string, RoleStats>
  }
  sim?: { costUsd: number }
}

export const median = (values: number[]) => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function readRuns(dir: string): RunResult[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'result.json')))
    .map((name) => JSON.parse(readFileSync(join(dir, name, 'result.json'), 'utf8')) as RunResult)
}

/** The published results (`results/<id>.json`, from `pnpm eval export`): enough to rebuild the matrix. */
export function readPublished(dir: string): RunResult[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunResult)
}

/** One row of the matrix: the runs of one commit × setup × scenario. */
export type Group = {
  commit: string
  setup: string
  scenario: string
  scenarioSha: string
  runs: RunResult[]
  passes: number
  medianMin?: number
  medianCost?: number
  /** Each feature's passing runs. */
  features: Record<string, number>
  /** Runs where Ultimate asked a multi-choice card, and where one was answered. */
  multi: { asked: number; answered: number }
  /** Runs with a failed `finding` check, and the median count of real tool errors. */
  withFindings: number
  medianToolErrors?: number
  failures: { id: string; status: string }[]
}

/** The runs grouped by commit × setup × scenario, in the order first seen. */
export function groups(runs: RunResult[]): Group[] {
  const byKey = new Map<string, RunResult[]>()
  // A run we stopped ourselves (Ctrl+C) says nothing about Ultimate: it stays in runs/ but out of the matrix.
  for (const r of runs.filter((r) => r.status !== 'cancelled')) {
    const key = `${r.pins.ultimateCommit}\0${r.pins.setup}\0${r.pins.scenario}\0${r.pins.scenarioSha}`
    byKey.set(key, [...(byKey.get(key) ?? []), r])
  }
  return [...byKey.values()].map((list) => {
    const { ultimateCommit, setup, scenario, scenarioSha } = list[0]!.pins
    const features: Record<string, number> = {}
    for (const r of list) for (const [f, ok] of Object.entries(r.features ?? {})) if (ok) features[f] = (features[f] ?? 0) + 1
    return {
      commit: ultimateCommit,
      setup,
      scenario,
      scenarioSha,
      runs: list,
      passes: list.filter((r) => r.pass).length,
      medianMin: median(list.flatMap((r) => (r.minutes === undefined ? [] : [r.minutes]))),
      medianCost: median(list.map((r) => (r.scorecard?.usage.totalCostUsd ?? 0) + (r.sim?.costUsd ?? 0))),
      features,
      multi: {
        asked: list.filter((r) => (r.scorecard?.questions?.multi ?? 0) > 0).length,
        answered: list.filter((r) => (r.scorecard?.questions?.multiAnswered ?? 0) > 0).length,
      },
      withFindings: list.filter((r) => r.scorecard?.checks?.some((c) => c.gate === 'finding' && !c.pass)).length,
      medianToolErrors: median(list.flatMap((r) => (r.scorecard?.toolErrors === undefined ? [] : [r.scorecard.toolErrors]))),
      failures: list.filter((r) => !r.pass).map((r) => ({ id: r.id, status: r.status })),
    }
  })
}

export function table(runs: RunResult[]) {
  const rows = [
    [
      'commit  setup  scenario',
      'pass/N',
      'median min',
      'median $',
      'features passing',
      'multi asked/answered',
      'findings',
      'tool errors',
      'failures',
    ],
  ]
  for (const g of groups(runs)) {
    const n = g.runs.length
    rows.push([
      `${g.commit.slice(0, 10)}  ${g.setup}  ${g.scenario}@${g.scenarioSha.slice(0, 6)}`,
      `${g.passes}/${n}`,
      g.medianMin === undefined ? '-' : g.medianMin.toFixed(1),
      (g.medianCost ?? 0).toFixed(2),
      Object.entries(g.features).map(([f, k]) => `${f} ${k}/${n}`).join(', ') || '-',
      `${g.multi.asked}/${n} ${g.multi.answered}/${n}`,
      `${g.withFindings}/${n}`,
      g.medianToolErrors === undefined ? '-' : String(g.medianToolErrors),
      g.failures.map((f) => f.status).join(', ') || '-',
    ])
  }
  return [align(rows), roleTable(runs)].filter(Boolean).join('\n\n')
}

const align = (rows: string[][]) => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n')
}

const ROLES = ['ultimate', 'coordinator', 'worker']
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)))

/** Mean calls per run by name, the most frequent first: `codemode 12, read 3.5`. */
function perRun(list: Record<string, number>[], top = 4) {
  const total: Record<string, number> = {}
  for (const counts of list) for (const [name, n] of Object.entries(counts)) total[name] = (total[name] ?? 0) + n
  const sorted = Object.entries(total).sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, top).map(([name, n]) => `${name} ${+(n / list.length).toFixed(1)}`)
  return (sorted.length > top ? [...shown, `+${sorted.length - top}`] : shown).join(', ') || '-'
}

/**
 * Per role, for the groups whose runs carry `byRole`: median turns and tokens, and mean top-level and nested codemode
 * calls per run, the most frequent first.
 */
export function roleTable(runs: RunResult[]) {
  const rows = [['commit  setup  scenario', 'role', 'N', 'turns', 'in/out/cache r/w tokens', 'tool calls per run', 'nested in codemode per run']]
  for (const g of groups(runs)) {
    const scored = g.runs.flatMap((r) => (r.scorecard?.byRole ? [r.scorecard.byRole] : []))
    if (!scored.length) continue
    for (const role of ROLES) {
      const stats = scored.map((b) => b[role] ?? { turns: 0, tools: {}, nested: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      const med = (key: 'turns' | 'input' | 'output' | 'cacheRead' | 'cacheWrite') => median(stats.map((s) => s[key]))!
      rows.push([
        `${g.commit.slice(0, 10)}  ${g.setup}  ${g.scenario}@${g.scenarioSha.slice(0, 6)}`,
        role,
        String(scored.length),
        String(med('turns')),
        [k(med('input')), k(med('output')), k(med('cacheRead')), k(med('cacheWrite'))].join('/'),
        perRun(stats.map((s) => s.tools)),
        perRun(stats.map((s) => s.nested)),
      ])
    }
  }
  return rows.length > 1 ? align(rows) : ''
}
