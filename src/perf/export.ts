import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scan } from '../export.ts'
import { ROOT } from '../run.ts'
import { perfRecordPath } from './batch.ts'
import type { PerfRecord } from './batch.ts'
import { flatten } from './report.ts'

const pin = (value: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('export refused: invalid commit pin')
  return value
}
const digest = (value: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('export refused: invalid harness diff digest')
  return value
}
const number = (value: number) => {
  if (!Number.isFinite(value)) throw new Error('export refused: invalid numeric field')
  return value
}

export function publicPerf(record: PerfRecord) {
  if (!record.complete) throw new Error('export refused: performance batch is not complete')
  const commits = record.commits.map(pin)
  return {
    commits,
    evalCommit: pin(record.evalCommit),
    ...(record.evalDiff === undefined ? {} : { evalDiff: digest(record.evalDiff) }),
    seeds: Object.fromEntries(commits.flatMap((commit) => {
      const seed = record.seeds[commit]
      return !seed || 'error' in seed ? [] : [[commit, {
        sidebar: number(seed.sidebar), turns: number(seed.turns),
        entryCounts: seed.entryCounts.map(number), toolCounts: seed.toolCounts.map(number),
      }]]
    })),
    samples: record.samples.map((pass) => {
      if (pass.gate !== 'ready' && pass.gate !== 'timeout') throw new Error('export refused: invalid load gate')
      return {
        commit: pin(pass.commit), repeat: number(pass.repeat),
        load1Start: number(pass.load1Start), load1End: number(pass.load1End),
        cpuBusy: pass.cpuBusy === null ? null : number(pass.cpuBusy), gate: pass.gate, waitedSec: number(pass.waitedSec),
        metrics: Object.fromEntries(Object.entries(flatten(pass.sample)).map(([key, { value }]) => [key, value])),
      }
    }),
  }
}

export function exportPerf(name: string, record: PerfRecord, out = join(ROOT, 'results', 'perf')) {
  perfRecordPath(name) // Validate the label before deriving an output filename.
  const text = JSON.stringify(publicPerf(record), null, 2) + '\n'
  const file = `${name}.json`
  const hits = [...new Set([...scan(file), ...scan(text)])]
  if (hits.length) throw new Error(`export refused, forbidden content: ${hits.join(', ')}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, file), text)
  return `results/perf/${file}`
}
