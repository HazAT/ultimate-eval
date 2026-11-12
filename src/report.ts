/** The matrix: runs grouped by setup (commit × model setup × scenario), with passes/N and median time and cost. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type RunResult = {
  id: string
  pass: boolean
  status: string
  minutes?: number
  pins: { ultimateCommit: string; setup: string; scenario: string; scenarioSha: string; simPromptSha: string }
  features?: Record<string, boolean>
  scorecard?: {
    usage: { totalCostUsd: number }
    coordinators: unknown[]
    workers: { total: number }
    questions?: { multi: number; multiAnswered?: number }
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
      failures: list.filter((r) => !r.pass).map((r) => ({ id: r.id, status: r.status })),
    }
  })
}

export function table(runs: RunResult[]) {
  const rows = [['commit  setup  scenario', 'pass/N', 'median min', 'median $', 'features passing', 'multi asked/answered', 'failures']]
  for (const g of groups(runs)) {
    const n = g.runs.length
    rows.push([
      `${g.commit.slice(0, 10)}  ${g.setup}  ${g.scenario}@${g.scenarioSha.slice(0, 6)}`,
      `${g.passes}/${n}`,
      g.medianMin === undefined ? '-' : g.medianMin.toFixed(1),
      (g.medianCost ?? 0).toFixed(2),
      Object.entries(g.features).map(([f, k]) => `${f} ${k}/${n}`).join(', ') || '-',
      `${g.multi.asked}/${n} ${g.multi.answered}/${n}`,
      g.failures.map((f) => f.status).join(', ') || '-',
    ])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n')
}
