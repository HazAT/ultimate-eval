import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { batchName, errorText } from '../ab.ts'
import { resolveCommit, ROOT } from '../run.ts'
import { measure } from './browser.ts'
import type { Sample } from './browser.ts'
import { perfInstance } from './instance.ts'
import { cpu, cpuBusy, load1, loadGate } from './load.ts'
import { seed } from './seed.ts'

const repo = join(homedir(), 'Projects', 'ultimate')
const unitOf = (name: string) => `ue-perf-${name}`
const runs = join(ROOT, 'runs')
export const perfRecordPath = (name: string) => {
  if (!name || name !== batchName(name)) throw new Error('invalid performance batch name')
  return join(runs, `perf-${name}.json`)
}

type Options = { name: string; commits: string[]; repeat: number; small: boolean }
export type SeedInfo = { sidebar: number; turns: number; entryCounts: number[]; toolCounts: number[]; seconds: number }
export type PerfPass = {
  commit: string; repeat: number; at: string; seconds: number
  load1Start: number; load1End: number; cpuBusy: number | null; gate: 'ready' | 'timeout'; waitedSec: number
} & ({ sample: Sample; error?: never } | { sample: null; error: string })
export type PerfRecord = Options & {
  evalCommit: string
  dates: Record<string, string>
  unit?: string
  pid: number
  startedAt: string
  finishedAt?: string
  seeds: Record<string, SeedInfo | { error: string }>
  samples: PerfPass[]
  error?: string
  complete: boolean
}

export function resolvePerf(options: Omit<Options, 'name'> & { name?: string }): Options {
  const commits = options.commits.map((ref) => resolveCommit(repo, ref))
  if (new Set(commits).size !== commits.length) throw new Error('duplicate performance commit')
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15).toLowerCase()
  const name = batchName(options.name ?? `${commits[0]!.slice(0, 7)}-${stamp}`)
  if (!name) throw new Error('--name has no usable characters')
  return { ...options, commits, name }
}

export function launchPerf(options: Options) {
  const { name } = options
  const unit = unitOf(name)
  const path = perfRecordPath(name)
  if (existsSync(path)) throw new Error(`${relative(ROOT, path)} exists: pick another --name`)
  const log = join(runs, `perf-${name}.log`)
  mkdirSync(runs, { recursive: true })
  execFileSync('systemd-run', [
    '--user', `--unit=${unit}`, `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH}`, `--setenv=HOME=${process.env.HOME}`,
    `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
    process.execPath, 'src/cli.ts', 'perf', '--foreground', '--unit', unit, '--name', name,
    '--repeat', String(options.repeat), ...(options.small ? ['--small'] : []),
    ...options.commits.flatMap((commit) => ['--commit', commit]),
  ], { stdio: 'inherit' })
  return { unit, record: relative(ROOT, path), log: relative(ROOT, log) }
}

export async function runPerf(options: Options & { unit?: string }) {
  const { name } = options
  const path = perfRecordPath(name)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const record: PerfRecord = {
    ...options,
    evalCommit: git(ROOT, 'rev-parse', 'HEAD'),
    dates: Object.fromEntries(options.commits.map((commit) => [commit, git(repo, 'show', '-s', '--format=%cs', commit)])),
    pid: process.pid, startedAt: new Date().toISOString(), seeds: {}, samples: [], complete: false,
  }
  mkdirSync(dirname(path), { recursive: true })
  const claim = `${path}.${process.pid}.claim`
  writeFileSync(claim, JSON.stringify(record, null, 2) + '\n')
  try { linkSync(claim, path) } finally { rmSync(claim, { force: true }) }
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
    renameSync(`${path}.tmp`, path)
  }

  type Instance = Awaited<ReturnType<typeof perfInstance>>
  const ready = new Map<string, { instance: Instance; data: Awaited<ReturnType<typeof seed>> }>()
  const cancel = new AbortController()
  const signal = cancel.signal
  const onSignal = (name: NodeJS.Signals) => cancel.abort(new Error(`${name}: performance batch cancelled`))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const detail = (error: unknown) => errorText(error instanceof Error ? error.message : String(error))
  const errors: string[] = []
  const size = options.small ? { sidebar: 50, turns: 100 } : { sidebar: 300, turns: 300 }
  const measureOptions = (commit: string) => ({ signal, log: (line: string) => console.log(`${commit.slice(0, 7)}: ${line}`) })
  try {
    for (const commit of options.commits) {
      signal.throwIfAborted()
      let instance: Instance | undefined
      try {
        instance = await perfInstance(commit, measureOptions(commit))
        const data = await seed(instance, { ...size, ...measureOptions(commit) })
        await instance.snapshot() // Stops the Ultimate server, but keeps its snapshot on disk for every repeat.
        ready.set(commit, { instance, data })
        record.seeds[commit] = { ...size, entryCounts: data.entryCounts, toolCounts: data.toolCounts, seconds: data.seconds }
      } catch (error) {
        record.seeds[commit] = { error: detail(error) }
        errors.push(`preflight ${commit.slice(0, 7)}: ${detail(error)}`)
        await instance?.stop()
      }
      save()
    }
    for (let repeat = 1; ready.size && repeat <= options.repeat; repeat++) {
      for (const [commit, { instance, data }] of ready) {
        signal.throwIfAborted()
        console.log(`perf ${name}: ${commit.slice(0, 7)} repeat ${repeat}/${options.repeat}, checking machine load`)
        const gate = await loadGate(signal)
        const at = new Date().toISOString()
        const began = performance.now()
        const startCpu = cpu()
        const result = await measure(instance, data, measureOptions(commit)).then(
          (sample) => ({ sample }),
          (error: unknown) => {
            const message = detail(error)
            errors.push(`${commit.slice(0, 7)} repeat ${repeat}: ${message}`)
            return { sample: null, error: message } as const
          },
        )
        try {
          const seconds = (performance.now() - began) / 1000
          record.samples.push({ commit, repeat, at, seconds, ...gate, load1End: load1(), cpuBusy: cpuBusy(startCpu, cpu()), ...result })
          save()
          console.log(`perf ${name}: ${commit.slice(0, 7)} repeat ${repeat} ${result.sample ? 'measured' : 'failed'} in ${seconds.toFixed(1)} s (gate ${gate.gate}, waited ${gate.waitedSec.toFixed(1)} s)`)
        } finally {
          await instance.halt()
        }
      }
    }
    signal.throwIfAborted()
  } catch (error) {
    errors.push(detail(error))
  } finally {
    for (const { instance } of ready.values()) {
      try { await instance.stop() } catch (error) { errors.push(`cleanup: ${detail(error)}`) }
    }
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (errors.length) record.error = errors.join('\n')
    record.complete = true
    record.finishedAt = new Date().toISOString()
    save()
  }
  console.log(`perf ${name}: ${record.error ? 'complete with errors' : 'complete'} → ${relative(ROOT, path)}`)
  return record
}

export const readPerf = (name: string): PerfRecord => JSON.parse(readFileSync(perfRecordPath(name), 'utf8'))

export function perfStatus(name: string) {
  const path = perfRecordPath(name)
  const unit = unitOf(name)
  const record = existsSync(path) ? readPerf(name) : undefined
  let active = 'inactive'
  if (!record || record.unit) {
    try { active = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim() }
    catch (error) { active = String((error as { stdout?: string }).stdout ?? '').trim() || 'inactive' }
  }
  if (!record) return `${unit}: ${active}, no record yet`
  let alive = active === 'active' || active === 'activating'
  if (!record.unit && !record.complete) {
    try { process.kill(record.pid, 0); alive = true } catch {}
  }
  return [
    `${name}: ${record.complete ? 'complete' : alive ? 'running' : 'batch gone'} (${record.unit ? `${unit} ${active}` : `foreground pid ${record.pid}`}), ${record.samples.length}/${record.commits.length * record.repeat} passes attempted`,
    ...record.commits.map((commit) => {
      const info = record.seeds[commit]
      const passes = record.samples.filter((pass) => pass.commit === commit)
      const seeded = !info ? 'preflight pending' : 'error' in info ? `preflight failed: ${info.error}` : `seeded in ${info.seconds.toFixed(1)} s`
      return `  ${commit.slice(0, 7)}: ${seeded}; ${passes.filter((pass) => pass.sample).length}/${record.repeat} samples`
    }),
    ...(record.error ? [`errors: ${record.error}`] : []),
  ].join('\n')
}
