import type { PerfRecord } from './batch.ts'
import { median } from './metrics.ts'

type Scalar = { value: number | null; error: boolean }
// Absolute reconnect timestamps are diagnostics, not metrics for public export.
const diagnostics = new Set(['reconnect.startedAt', 'reconnect.readyAt', 'reconnect.viewAt', 'reconnect.firstEventAt'])

/** Keep each numeric metric under the name the sample recorded, including historical and unknown fields. */
export function flatten(sample: unknown): Record<string, Scalar> {
  const metrics: Record<string, Scalar> = Object.create(null)
  type Add = (key: string, value: number | null, error: boolean) => void
  function walk(key: string, value: unknown, add: Add) {
    if (diagnostics.has(key)) return
    if (value === null || typeof value === 'number') {
      if (value !== null && !Number.isFinite(value)) throw new Error(`invalid number for ${key}`)
      add(key, value, false)
    } else if (value && typeof value === 'object') {
      if ('error' in value && typeof value.error === 'string') { add(key, null, true); return }
      if (Array.isArray(value) && (key === 'switch.cold' || key === 'switch.warm')) {
        // Keep per-pass medians rather than publishing conversation IDs or round indices.
        const values = new Map<string, number[]>()
        for (const { id, round, ...point } of value) walk(key, point, (path, n) => {
          const numbers = values.get(path) ?? []
          if (n !== null) numbers.push(n)
          values.set(path, numbers)
        })
        for (const [path, numbers] of values) add(path, median(numbers), false)
      } else if (Array.isArray(value) && key === 'streaming.progress.markers') {
        for (const [index, mark] of value.entries()) {
          const { line, ...point } = mark
          if (Number.isSafeInteger(line)) walk(`streaming.line${line}`, point, add)
          else walk(`${key}.${index}`, mark, add)
        }
      } else {
        for (const [name, child] of Object.entries(value)) walk(key ? `${key}.${name}` : name, child, add)
      }
    }
  }
  if (sample != null) walk('', sample, (key, value, error) => { metrics[key] = { value, error } })
  return metrics
}

/** Keep both harness versions and differently sized workloads in separate blocks. */
export function groupPerf(records: PerfRecord[]) {
  const groups = new Map<string, PerfRecord[]>()
  for (const record of records) {
    const key = `${record.evalCommit}:${record.evalDiff ?? 'clean'}:${record.small ? 'small' : 'default'}`
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function perfReport(records: PerfRecord[]) {
  if (!records.length) return 'No performance batches recorded.'
  const number = (n: number | null) => n === null ? '—' : n.toFixed(2)
  return groupPerf(records).map((group) => {
    const first = group[0]!
    const commits = new Map<string, string>()
    for (const record of group) for (const commit of record.commits) commits.set(commit, record.dates[commit] ?? '?')
    const passes = group.flatMap((record) => record.samples.map((pass) => {
      const metrics = flatten(pass.sample)
      const failures = Object.keys(metrics).filter((key) => metrics[key]!.error)
      return { ...pass, metrics, failures }
    }))
    const lines = [`eval ${first.evalCommit}${first.evalDiff ? ` + ${first.evalDiff}` : ''} · ${first.small ? 'small' : 'default'} · ${group.map((r) => r.name).join(', ')}`]
    const keys = new Set(passes.flatMap((pass) => Object.keys(pass.metrics)))
    if (!keys.size) lines.push('', `No metrics recorded (${passes.filter((pass) => pass.sample === null).length} failed passes).`)
    for (const key of keys) {
      lines.push('', key, 'commit              median            min–max    n   errors')
      for (const [commit, date] of commits) {
        const values: number[] = []
        let errors = 0
        for (const pass of passes) {
          if (pass.commit !== commit) continue
          if (pass.sample === null || pass.failures.some((path) => key === path || key.startsWith(`${path}.`))) errors++
          const value = pass.metrics[key]?.value
          if (value != null) values.push(value)
        }
        const range = values.length ? `${number(Math.min(...values))}–${number(Math.max(...values))}` : '—'
        lines.push(`${commit.slice(0, 7)} ${date} ${number(median(values)).padStart(8)} ${range.padStart(18)} ${String(values.length).padStart(4)} ${String(errors).padStart(8)}`)
      }
    }
    return lines.join('\n')
  }).join('\n\n')
}
