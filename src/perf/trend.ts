/**
 * The performance trend for Bench: every batch in `results/perf/*.json` (exported) and `runs/perf-*.json` (local; it
 * wins over an export of the same name), one point per batch × Ultimate commit, grouped into eval versions so a line
 * never crosses a change to the code that measures.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PerfRecord } from './batch.ts'
import type { Sample } from './browser.ts'
import { median } from './metrics.ts'
import { flatten } from './report.ts'

/** One pass as both sources can give it: flat metrics, and for a local record its raw sample and errors. */
export type TrendPass = {
  commit: string
  repeat: number
  at?: string
  seconds?: number
  load1Start: number
  load1End: number
  cpuBusy: number | null
  gate: 'ready' | 'timeout'
  waitedSec: number
  metrics: Record<string, number | null>
  /** Metric paths that failed, with the error when the record kept it (exports keep none). */
  errors: Record<string, string | null>
  /** A whole pass that failed before any sample. */
  error?: string
  /** Every switch, cold and warm; exports keep only their per-pass medians. */
  switches?: Extract<Sample['switch'], { cold: unknown }>
}
export type TrendBatch = {
  name: string
  source: 'local' | 'export'
  evalCommit: string
  evalDiff?: string
  small: boolean
  startedAt?: string
  complete: boolean
  commits: string[]
  passes: TrendPass[]
}
export type Stat = { median: number | null; min: number | null; max: number | null; n: number; failed: number }
export type TrendPoint = {
  batch: string
  source: TrendBatch['source']
  commit: string
  /** The Ultimate commit's committer date, ISO, when the clone knows it. */
  date?: string
  evalCommit: string
  n: number
  metrics: Record<string, Stat>
}
export type TrendVersion = { key: string; evalCommits: string[]; evalDiff?: string; small: boolean; points: TrendPoint[] }

/** Files under src/perf/ that only read, report or export results: changing them does not change a measurement. */
const REPORTING = new Set(['cli.ts', 'export.ts', 'measure-once.ts', 'report.ts', 'smoke.ts', 'trend.ts'])

/** The measuring code at an eval commit: its src/perf/ files (but the reporting ones), package.json and the lockfile. */
export function measuringCode(root: string, evalCommit: string) {
  pinned(evalCommit)
  const tree = execFileSync('git', ['ls-tree', '-r', evalCommit, '--', 'src/perf/', 'package.json', 'pnpm-lock.yaml'], {
    cwd: root, encoding: 'utf8',
  })
  const kept = tree.split('\n').filter((line) => {
    const path = line.split('\t')[1]
    return path && !(path.startsWith('src/perf/') && REPORTING.has(path.slice('src/perf/'.length)))
  })
  return createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 16)
}

/** A commit pin from a record, checked before it reaches git as an argument. */
const pinned = (sha: string) => {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit pin: ${String(sha).slice(0, 50)}`)
  return sha
}
/** A batch whose pins are all commits; any other is skipped. */
const valid = (batch: TrendBatch) => {
  pinned(batch.evalCommit)
  for (const commit of [...batch.commits, ...batch.passes.map((p) => p.commit)]) pinned(commit)
  return batch
}

const records = (dir: string, pattern: RegExp) =>
  existsSync(dir) ? readdirSync(dir).flatMap((file) => {
    const name = pattern.exec(file)?.[1]
    return name ? [{ name, path: join(dir, file) }] : []
  }) : []

/** Errors in a raw sample, by metric path, with their message. */
function errorsOf(sample: unknown) {
  const errors: Record<string, string | null> = {}
  const walk = (path: string, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    if ('error' in value && typeof value.error === 'string') { errors[path] = value.error; return }
    for (const [key, child] of Object.entries(value)) walk(path ? `${path}.${key}` : key, child)
  }
  walk('', sample)
  return errors
}

export function fromLocal(name: string, record: PerfRecord): TrendBatch {
  return {
    name, source: 'local', evalCommit: record.evalCommit, ...(record.evalDiff ? { evalDiff: record.evalDiff } : {}),
    small: record.small, startedAt: record.startedAt, complete: record.complete, commits: record.commits,
    passes: record.samples.map((pass) => {
      const flat = pass.sample ? flatten(pass.sample) : {}
      const { sample, error, ...meta } = pass
      return {
        ...meta,
        metrics: Object.fromEntries(Object.entries(flat).map(([key, { value }]) => [key, value])),
        errors: sample ? errorsOf(sample) : {},
        ...(error ? { error } : {}),
        ...(sample?.switch && 'cold' in sample.switch ? { switches: sample.switch } : {}),
      }
    }),
  }
}

type Exported = ReturnType<typeof import('./export.ts').publicPerf>
export function fromExport(name: string, record: Exported): TrendBatch {
  // An export drops `small`; its seeds say how large the workload was.
  const seeds = Object.values(record.seeds)
  return {
    name, source: 'export', evalCommit: record.evalCommit, ...(record.evalDiff ? { evalDiff: record.evalDiff } : {}),
    small: seeds.length > 0 && seeds.every((seed) => seed.sidebar < 300), complete: true, commits: record.commits,
    passes: record.samples.map((pass) => {
      // An export keeps a failed measurement as one null under its path; a null leaf elsewhere is a missing observation.
      const errors = Object.fromEntries(Object.entries(pass.metrics).flatMap(([key, value]) =>
        value === null && MEASUREMENTS.has(key) ? [[key, null]] : []))
      // publicPerf writes a pass that failed before any sample as empty metrics.
      const failed = Object.keys(pass.metrics).length === 0
      return { ...pass, metrics: pass.metrics, errors, ...(failed ? { error: 'the pass failed before any measurement' } : {}) }
    }),
  }
}

/** The paths of `Sample` that `measure` records as `{ error }` when they fail (its `Metric<…>` fields). */
const MEASUREMENTS = new Set(['firstBuildMs', 'firstLoad.cold', 'firstLoad.warm', 'sendToResponse', 'ttft', 'switch',
  'streaming', 'memory', 'reconnect', 'reconnect.restartBuildMs', 'keypress'])

/** Every batch on disk: local records first, so an exported copy of the same batch is skipped. */
export function readBatches(root: string): TrendBatch[] {
  const batches = new Map<string, TrendBatch>()
  for (const { name, path } of records(join(root, 'runs'), /^perf-([a-zA-Z0-9-]+)\.json$/)) {
    try { batches.set(name, valid(fromLocal(name, JSON.parse(readFileSync(path, 'utf8'))))) } catch {}
  }
  for (const { name, path } of records(join(root, 'results', 'perf'), /^([a-zA-Z0-9-]+)\.json$/)) {
    if (batches.has(name)) continue
    try { batches.set(name, valid(fromExport(name, JSON.parse(readFileSync(path, 'utf8'))))) } catch {}
  }
  return [...batches.values()]
}

export type TrendInfo = {
  /** The same value for two eval commits whose measuring code is identical. */
  version: (evalCommit: string) => string
  /** An Ultimate commit's date, ISO. */
  date: (commit: string) => string | undefined
}

function stat(passes: TrendPass[], key: string): Stat {
  const values = passes.flatMap((pass) => {
    const value = Object.hasOwn(pass.metrics, key) ? pass.metrics[key] : undefined
    return typeof value === 'number' ? [value] : []
  })
  const failed = passes.filter((pass) => pass.error !== undefined ||
    Object.keys(pass.errors).some((path) => key === path || key.startsWith(`${path}.`))).length
  return {
    median: median(values), n: values.length, failed,
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
  }
}

/**
 * Versions in order of their first point, each with its points in Ultimate commit date order (then batch start). A
 * dirty harness only matches the same diff, and a small workload never a default one.
 */
export function trend(batches: TrendBatch[], info: TrendInfo, always: readonly string[] = []): TrendVersion[] {
  const versions = new Map<string, TrendVersion>()
  const passesOf = new Map<TrendPoint, TrendPass[]>()
  for (const batch of batches) {
    const key = `${info.version(batch.evalCommit)}:${batch.evalDiff ?? 'clean'}:${batch.small ? 'small' : 'default'}`
    const version = versions.get(key) ??
      { key, evalCommits: [], ...(batch.evalDiff ? { evalDiff: batch.evalDiff } : {}), small: batch.small, points: [] }
    versions.set(key, version)
    if (!version.evalCommits.includes(batch.evalCommit)) version.evalCommits.push(batch.evalCommit)
    for (const commit of batch.commits) {
      const passes = batch.passes.filter((pass) => pass.commit === commit)
      if (!passes.length) continue
      const date = info.date(commit)
      const point: TrendPoint = {
        batch: batch.name, source: batch.source, commit, ...(date ? { date } : {}), evalCommit: batch.evalCommit,
        n: passes.length, metrics: {},
      }
      version.points.push(point)
      passesOf.set(point, passes)
    }
  }
  // Every point carries every metric of its version, so one that failed or never reached it shows as a gap.
  for (const version of versions.values()) {
    // `always` (the charted metrics) too, so a version where a measurement never succeeded still shows its failures.
    const keys = new Set([...always, ...version.points.flatMap((p) => passesOf.get(p)!.flatMap((pass) => Object.keys(pass.metrics)))])
    for (const point of version.points) point.metrics = Object.fromEntries([...keys].map((k) => [k, stat(passesOf.get(point)!, k)]))
  }
  const started = new Map(batches.map((b) => [b.name, b.startedAt ?? '']))
  const order = (a: TrendPoint, b: TrendPoint) =>
    (a.date ?? '').localeCompare(b.date ?? '') || started.get(a.batch)!.localeCompare(started.get(b.batch)!) || a.batch.localeCompare(b.batch)
  const list = [...versions.values()].filter((v) => v.points.length)
  for (const version of list) version.points.sort(order)
  return list.sort((a, b) => order(a.points[0]!, b.points[0]!))
}

const cache = new Map<string, string | undefined>()
const once = (key: string, read: () => string | undefined) => {
  if (!cache.has(key)) {
    try { cache.set(key, read()) } catch { cache.set(key, undefined) }
  }
  return cache.get(key)
}

/** The trend of every batch on disk, versions read from this repository's history and dates from Ultimate's clone. */
export function perfTrend(root: string, always: readonly string[] = [], repo = join(homedir(), 'Projects', 'ultimate')) {
  return trend(readBatches(root), {
    // An eval commit this clone does not have (yet) is its own version.
    version: (evalCommit) => once(`v:${evalCommit}`, () => measuringCode(root, evalCommit)) ?? evalCommit,
    date: (commit) => once(`d:${commit}`, () =>
      execFileSync('git', ['show', '-s', '--format=%cI', pinned(commit)], { cwd: repo, encoding: 'utf8' }).trim() || undefined),
  }, always)
}

/** One batch's passes on one Ultimate commit, in full. */
export function perfPoint(root: string, batch: string, commit: string) {
  const found = readBatches(root).find((b) => b.name === batch)
  if (!found) throw new Error(`No performance batch ${batch}`)
  const { passes, ...meta } = found
  return { ...meta, passes: passes.filter((pass) => pass.commit === commit) }
}
