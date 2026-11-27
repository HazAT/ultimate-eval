import type { PerfRecord } from './batch.ts'
import type { Sample } from './browser.ts'
import { median } from './metrics.ts'

type Scalar = { value: number | null; error: boolean }
type MetricError = { error: string }

/** Fixed metric names, not a recursive JSON walk: IDs, timestamps and error messages are not metrics. */
export function flatten(sample?: Sample | null): Record<string, Scalar> {
  const metrics: Record<string, Scalar> = {}
  const failed = (value: unknown): value is MetricError => !!value && typeof value === 'object' && 'error' in value
  const add = (key: string, value: number | null | undefined | MetricError, parentError = false) => {
    if (value != null && !failed(value) && !Number.isFinite(value)) throw new Error(`invalid number for ${key}`)
    metrics[key] = { value: value == null || failed(value) ? null : value, error: parentError || failed(value) }
  }
  const fields = <T extends object>(prefix: string, item: T | MetricError | null | undefined, keys: (keyof T & string)[], parentError = false) => {
    for (const key of keys) {
      const value = failed(item) ? item : item?.[key] as number | null | undefined
      add(`${prefix}.${key}`, value, parentError)
    }
  }
  const success = <T>(item: T | MetricError | undefined): T | undefined => failed(item) ? undefined : item

  add('firstBuildMs', sample?.firstBuildMs)
  for (const mode of ['cold', 'warm'] as const) {
    fields(`firstLoad.${mode}`, sample?.firstLoad?.[mode], ['dclMs', 'fcpMs', 'transcriptMs', 'transferBytes'])
  }
  fields('sendToResponse', sample?.sendToResponse, ['userMs', 'answerMs'])
  fields('ttft', sample?.ttft, ['serverPrepMs', 'streamToPaintMs', 'totalMs'])
  const switches = success(sample?.switch)
  for (const mode of ['cold', 'warm'] as const) {
    for (const key of ['settledMs', 'longMs'] as const) {
      const values = switches?.[mode]?.map((entry) => entry[key]) ?? []
      if (!values.every(Number.isFinite)) throw new Error(`invalid number for switch.${mode}.${key}`)
      add(`switch.${mode}.${key}`, median(values), failed(sample?.switch))
    }
  }
  const streaming = success(sample?.streaming)
  fields('streaming.longtask', streaming?.longtask, ['count', 'totalMs', 'p95Ms'], failed(sample?.streaming))
  fields('streaming.longAnimationFrame', streaming?.longAnimationFrame, ['count', 'totalMs'], failed(sample?.streaming))
  add('streaming.rafGapsOver33Ms', streaming?.rafGapsOver33Ms, failed(sample?.streaming))
  fields('memory', sample?.memory, ['jsHeapUsedMB', 'nodes', 'jsEventListeners'])
  fields('reconnect', sample?.reconnect, ['readyToEventMs', 'outageMs'])
  add('reconnect.restartBuildMs', success(sample?.reconnect)?.restartBuildMs, failed(sample?.reconnect))
  const keypress = success(sample?.keypress)
  add('keypress.count', keypress?.count, failed(sample?.keypress))
  fields('keypress.duration', keypress?.duration, ['medianMs', 'p95Ms'], failed(sample?.keypress))
  fields('keypress.inputDelay', keypress?.inputDelay, ['medianMs', 'p95Ms'], failed(sample?.keypress))
  return metrics
}

/** Keep both harness versions and differently sized workloads in separate blocks. */
export function groupPerf(records: PerfRecord[]) {
  const groups = new Map<string, PerfRecord[]>()
  for (const record of records) {
    const key = `${record.evalCommit}:${record.small ? 'small' : 'default'}`
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
    const passes = group.flatMap((record) => record.samples.map((pass) => ({ ...pass, metrics: flatten(pass.sample) })))
    const lines = [`eval ${first.evalCommit} · ${first.small ? 'small' : 'default'} · ${group.map((r) => r.name).join(', ')}`]
    for (const [key, empty] of Object.entries(flatten())) {
      lines.push('', key, 'commit              median            min–max    n   errors')
      for (const [commit, date] of commits) {
        const values: number[] = []
        let errors = 0
        for (const pass of passes) {
          if (pass.commit !== commit) continue
          const metric = pass.metrics[key] ?? empty
          if (pass.sample === null || metric.error) errors++
          if (metric.value !== null) values.push(metric.value)
        }
        const range = values.length ? `${number(Math.min(...values))}–${number(Math.max(...values))}` : '—'
        lines.push(`${commit.slice(0, 7)} ${date} ${number(median(values)).padStart(8)} ${range.padStart(18)} ${String(values.length).padStart(4)} ${String(errors).padStart(8)}`)
      }
    }
    return lines.join('\n')
  }).join('\n\n')
}
