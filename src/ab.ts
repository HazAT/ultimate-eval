/**
 * An A/B batch: two Ultimate commits (base and head) on one or more scenarios, `--repeat` runs each, one run at a time,
 * base and head alternating, `EVAL_PLAN=i/N` across the whole batch. Both commits pass preflight first, so a setup
 * that cannot run stops the batch before anything is spent. Unless `--foreground`, it starts itself as the user unit
 * `ue-ab-<name>`, which survives a restart of the Ultimate host. `runs/ab-<name>.json` records the batch: rewritten
 * after each run, `complete: true` once nothing more will run. Watch `systemctl --user is-active ue-ab-<name>`, then
 * read the record; never a log line.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { preflight } from './preflight.ts'
import type { Preflight } from './preflight.ts'
import { resolveCommit, ROOT, run } from './run.ts'

export type AbOptions = {
  repo: string
  base: string
  head: string
  scenarios: string[]
  repeat: number
  setupPath: string
  name?: string
}

export type Planned = { arm: 'base' | 'head'; commit: string; scenario: string }
export type AbRun = {
  id: string
  arm: 'base' | 'head'
  commit: string
  scenario: string
  pass: boolean
  status: string
  minutes?: number
  cost: number
}
export type AbRecord = {
  name: string
  base: string
  head: string
  scenarios: string[]
  repeat: number
  setup: string
  evalCommit?: string
  /** The user unit it runs in; absent for `--foreground`. */
  unit?: string
  /** The batch's process, for a foreground batch's liveness. */
  pid: number
  startedAt: string
  finishedAt?: string
  /** How many runs the batch plans. */
  total: number
  preflight: Preflight[]
  runs: AbRun[]
  /** Why the batch stopped early: a failed preflight, a run the harness could not run, a cancel, an error. */
  error?: string
  /** True once nothing more will run, whether every run happened or not. */
  complete: boolean
}

/** Per scenario, `repeat` pairs of base then head. */
export function planBatch(base: string, head: string, scenarios: string[], repeat: number): Planned[] {
  return scenarios.flatMap((scenario) =>
    Array.from({ length: repeat }, () => [
      { arm: 'base' as const, commit: base, scenario },
      { arm: 'head' as const, commit: head, scenario },
    ]).flat(),
  )
}

/** One run's line in the record, from its `result.json`; cost is the agents' and the simulated user's. */
export function abRun(planned: Planned, result: Record<string, unknown>): AbRun {
  const card = result.scorecard as { usage?: { totalCostUsd?: number } } | undefined
  const cost = (card?.usage?.totalCostUsd ?? 0) + ((result.simCostUsd as number | undefined) ?? 0)
  return {
    id: result.id as string,
    ...planned,
    pass: result.pass === true,
    status: (result.status as string | undefined) ?? 'unknown',
    ...(typeof result.minutes === 'number' ? { minutes: result.minutes } : {}),
    cost: Math.round(cost * 100) / 100,
  }
}

/** A batch name usable as a unit and a file name. */
export const batchName = (name: string) => name.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
export const recordPath = (name: string) => join(ROOT, 'runs', `ab-${name}.json`)
export const unitOf = (name: string) => `ue-ab-${name}`

/** Replace the record atomically, so a watcher never reads half of it. */
export function writeRecord(path: string, record: AbRecord) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
}

/** Full shas and a default name, before anything starts: a moving `main` cannot change the batch. */
export function resolveBatch(options: AbOptions) {
  const base = resolveCommit(options.repo, options.base)
  const head = resolveCommit(options.repo, options.head)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase()
  const name = batchName(options.name ?? `${base.slice(0, 7)}-${head.slice(0, 7)}-${stamp}`)
  if (!name) throw new Error('--name has no usable characters')
  return { ...options, base, head, name }
}

/**
 * Run the batch in this process: preflight both commits, then every planned run, recording as it goes. A run the
 * harness could not run (`error`) or a cancel stops the batch: the next run would spend for nothing. A run that hung
 * or timed out is a result, and the batch goes on. Resolves to the record; `error` set means it stopped early.
 */
export async function runBatch(
  options: AbOptions & { name: string; unit?: string },
  deps = { run, preflight, path: recordPath(options.name) },
) {
  const { path } = deps
  const plan = planBatch(options.base, options.head, options.scenarios, options.repeat)
  let evalCommit: string | undefined
  try {
    evalCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {}
  const record: AbRecord = {
    name: options.name,
    base: options.base,
    head: options.head,
    scenarios: options.scenarios,
    repeat: options.repeat,
    setup: relative(ROOT, options.setupPath),
    ...(evalCommit ? { evalCommit } : {}),
    ...(options.unit ? { unit: options.unit } : {}),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    total: plan.length,
    preflight: [],
    runs: [],
    complete: false,
  }
  // The name is this batch's alone: claimed exclusively, so no second batch (unit or foreground) overwrites it.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  const save = () => writeRecord(path, record)

  const stop = await (async () => {
    try {
      // Each commit once, on the first scenario: what it checks (stream, agents, models, logins) is the setup's.
      for (const commit of [options.base, options.head]) {
        record.preflight.push(
          await deps.preflight({ repo: options.repo, commit, setupPath: options.setupPath, scenario: options.scenarios[0]! }),
        )
        save()
      }
      const failed = record.preflight.filter((p) => !p.ok)
      if (failed.length)
        return `preflight failed: ${failed.map((p) => `${p.commit.slice(0, 7)}: ${p.problems.join('; ')}`).join(' | ')}`
      for (const [i, planned] of plan.entries()) {
        process.env.EVAL_PLAN = `${i + 1}/${plan.length}`
        console.log(`ab ${options.name}: run ${i + 1}/${plan.length}, ${planned.arm} ${planned.commit.slice(0, 7)} on ${planned.scenario}`)
        const result = await deps.run({
          repo: options.repo,
          commit: planned.commit,
          setupPath: options.setupPath,
          scenario: planned.scenario,
          ...(evalCommit ? { evalCommit } : {}),
        })
        record.runs.push(abRun(planned, result))
        save()
        if (result.status === 'cancelled') return 'cancelled'
        if (result.status === 'error') {
          const detail = String((result.failure as { detail?: string } | undefined)?.detail ?? '').split('\n')[0]
          return `${planned.arm} run ${result.id} could not run: ${detail}`
        }
      }
      return undefined
    } catch (error) {
      return String(error instanceof Error ? error.message : error)
    }
  })()
  if (stop) record.error = stop
  record.finishedAt = new Date().toISOString()
  record.complete = true
  save()
  console.log(`ab ${options.name}: ${stop ? `stopped: ${stop}` : 'complete'} → ${relative(ROOT, path)}`)
  return record
}

/** Start the batch as the user unit `ue-ab-<name>`, running this CLI in the foreground inside it. */
export function launchUnit(options: AbOptions & { name: string }) {
  const unit = unitOf(options.name)
  if (existsSync(recordPath(options.name))) throw new Error(`${relative(ROOT, recordPath(options.name))} exists: pick another --name`)
  const args = [
    'src/cli.ts', 'ab', '--foreground', '--unit', unit, '--name', options.name, '--repo', options.repo,
    '--base', options.base, '--head', options.head, '--repeat', String(options.repeat),
    '--setup', options.setupPath, ...options.scenarios.flatMap((s) => ['--scenario', s]),
  ]
  const log = join(ROOT, 'runs', `ab-${options.name}.log`)
  mkdirSync(dirname(log), { recursive: true })
  execFileSync('systemd-run', [
    '--user', `--unit=${unit}`, `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH}`, `--setenv=HOME=${process.env.HOME}`,
    `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
    process.execPath, ...args,
  ], { stdio: 'inherit' })
  return { unit, record: relative(ROOT, recordPath(options.name)), log: relative(ROOT, log) }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Where batch `name` stands: its record and whether its unit still runs. */
export function batchStatus(name: string) {
  const path = recordPath(name)
  let active = 'unknown'
  try {
    active = execFileSync('systemctl', ['--user', 'is-active', unitOf(name)], { encoding: 'utf8' }).trim()
  } catch (e) {
    active = String((e as { stdout?: string }).stdout ?? '').trim() || 'inactive'
  }
  const record = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AbRecord) : undefined
  return { unit: unitOf(name), active, record }
}

export function formatStatus({ unit, active, record }: ReturnType<typeof batchStatus>) {
  if (!record) return `${unit}: ${active}, no record yet`
  const passes = (arm: string) => {
    const runs = record.runs.filter((r) => r.arm === arm)
    return `${runs.filter((r) => r.pass).length}/${runs.length}`
  }
  const lines = [
    `${record.name}: ${record.complete ? 'complete' : 'running'} (${record.unit ? `unit ${unit} ${active}` : `foreground pid ${record.pid}`}), ${record.runs.length}/${record.total} runs`,
    `base ${record.base.slice(0, 7)} ${passes('base')} pass · head ${record.head.slice(0, 7)} ${passes('head')} pass`,
    ...record.preflight.map((p) => `preflight ${p.commit.slice(0, 7)}: ${p.ok ? 'ok' : `FAILED ${p.problems.join('; ')}`}`),
    ...record.runs.map(
      (r) => `${r.id} ${r.arm} ${r.scenario} ${r.pass ? 'pass' : `FAIL (${r.status})`} ${r.minutes ?? '?'} min $${r.cost}`,
    ),
    ...(record.error ? [`stopped: ${record.error}`] : []),
  ]
  // A unit batch dies with its unit; a foreground batch with its process.
  const alive = record.unit ? active === 'active' || active === 'activating' : pidAlive(record.pid)
  if (!record.complete && !alive) lines.push('the record is not complete and its batch is gone: it died (see the log)')
  return lines.join('\n')
}
