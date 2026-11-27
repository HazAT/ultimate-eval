import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ROOT } from '../run.ts'
import { launchPerf, perfStatus, readPerf, resolvePerf, runPerf } from './batch.ts'
import { exportPerf } from './export.ts'
import { perfReport } from './report.ts'

export async function perfCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      commit: { type: 'string', multiple: true }, repeat: { type: 'string', default: '3' },
      name: { type: 'string' }, small: { type: 'boolean', default: false },
      foreground: { type: 'boolean' }, unit: { type: 'string' },
      status: { type: 'string' }, report: { type: 'boolean' }, export: { type: 'string' },
    },
    allowPositionals: true,
  })
  if ([values.status !== undefined, values.report, values.export !== undefined].filter(Boolean).length > 1) {
    throw new Error('choose one of --status, --report or --export')
  }
  if (!values.report && positionals.length) throw new Error('only --report takes positional batch names')
  if (values.status !== undefined) console.log(perfStatus(values.status))
  else if (values.report) {
    const runs = join(ROOT, 'runs')
    const names = positionals.length ? positionals : existsSync(runs) ? readdirSync(runs).flatMap((file) =>
      /^perf-([a-zA-Z0-9-]+)\.json$/.exec(file)?.[1] ?? []) : []
    console.log(perfReport([...new Set(names)].map(readPerf)))
  } else if (values.export !== undefined) {
    console.log(`exported ${exportPerf(values.export, readPerf(values.export))}`)
  } else {
    const repeat = Number(values.repeat)
    if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer')
    if (!values.commit?.length) throw new Error('perf needs at least one --commit')
    const batch = resolvePerf({ commits: values.commit, repeat, name: values.name, small: values.small })
    if (values.foreground) {
      const record = await runPerf({ ...batch, ...(values.unit ? { unit: values.unit } : {}) })
      if (record.error) process.exitCode = 1
    } else {
      const { unit, record, log } = launchPerf(batch)
      console.log(`started ${unit}\nwatch: systemctl --user is-active ${unit}  (then read ${record})\nprogress: pnpm eval perf --status ${batch.name}\nlog: ${log}`)
    }
  }
}
