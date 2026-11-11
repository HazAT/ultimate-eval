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
  scorecard?: { usage: { totalCostUsd: number }; coordinators: unknown[]; workers: { total: number } }
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

export function table(runs: RunResult[]) {
  const groups = new Map<string, RunResult[]>()
  for (const r of runs) {
    const key = `${r.pins.ultimateCommit.slice(0, 10)}  ${r.pins.setup}  ${r.pins.scenario}@${r.pins.scenarioSha.slice(0, 6)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const rows = [['commit  setup  scenario', 'pass/N', 'median min', 'median $', 'features passing', 'failures']]
  for (const [key, list] of groups) {
    const features = new Map<string, number>()
    for (const r of list) for (const [f, ok] of Object.entries(r.features ?? {})) if (ok) features.set(f, (features.get(f) ?? 0) + 1)
    const cost = list.map((r) => (r.scorecard?.usage.totalCostUsd ?? 0) + (r.sim?.costUsd ?? 0))
    const min = median(list.flatMap((r) => (r.minutes === undefined ? [] : [r.minutes])))
    rows.push([
      key,
      `${list.filter((r) => r.pass).length}/${list.length}`,
      min === undefined ? '-' : min.toFixed(1),
      (median(cost) ?? 0).toFixed(2),
      [...features].map(([f, n]) => `${f} ${n}/${list.length}`).join(', ') || '-',
      list.filter((r) => !r.pass).map((r) => r.status).join(', ') || '-',
    ])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n')
}
