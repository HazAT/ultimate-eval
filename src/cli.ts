/**
 * pnpm eval run --commit <sha> [--setup setups/today.json] [--scenario recipe-v2] [--repeat N] [--repo PATH] [--keep]
 * pnpm eval report [--from results]   the matrix from runs/, or from the published results/
 * pnpm eval export   write results/<id>.json, the cleaned-up public result of every finished run
 * pnpm eval rescore [run id…]   rebuild scorecards of finished runs from what they stored
 * pnpm eval ab --base <sha> --head <sha> --scenario NAME [--scenario …] [--repeat N] [--setup FILE] [--name LABEL]
 *   [--foreground]   an A/B batch, preflight first, as the user unit ue-ab-<name>; runs/ab-<name>.json records it
 * pnpm eval ab --status <name>   where a batch stands
 * pnpm eval preflight --commit <sha> [--setup FILE] [--scenario NAME]   can this commit run this setup (no model calls)
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readdirSync } from 'node:fs'
import { batchStatus, formatStatus, launchUnit, resolveBatch, runBatch } from './ab.ts'
import { exportResults } from './export.ts'
import { preflight } from './preflight.ts'
import { readPublished, readRuns, table } from './report.ts'
import { rescore } from './rescore.ts'
import { ROOT, run } from './run.ts'
import { findings } from './score.ts'

const { values, positionals } = parseArgs({
  options: {
    commit: { type: 'string', default: 'main' },
    setup: { type: 'string', default: 'setups/today.json' },
    scenario: { type: 'string', multiple: true },
    base: { type: 'string' },
    head: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string' },
    foreground: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
    repo: { type: 'string', default: join(homedir(), 'Projects/ultimate') },
    keep: { type: 'boolean', default: false },
    from: { type: 'string', default: 'runs' },
  },
  allowPositionals: true,
})

const command = positionals[0]
const scenarios = values.scenario?.length ? values.scenario : ['recipe-v2']
if (command !== 'ab' && scenarios.length > 1) throw new Error('only ab takes more than one --scenario')
if (command === 'run') {
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer')
  for (let i = 0; i < repeat; i++) {
    const result = await run({
      repo: resolve(values.repo),
      commit: values.commit,
      setupPath: resolve(ROOT, values.setup),
      scenario: scenarios[0]!,
      keep: values.keep,
      repeat: { index: i + 1, total: repeat },
    })
    // A cancel (Ctrl+C, TERM, the Bench surface's Cancel) stops the remaining repeats too.
    if (result.status === 'cancelled') break
  }
  console.log(`\n${table(readRuns(join(ROOT, 'runs')))}`)
  console.log(`\nexported ${exportResults(join(ROOT, 'runs'), join(ROOT, 'results'))} results to results/`)
} else if (command === 'ab' && values.status) {
  console.log(formatStatus(batchStatus(values.status)))
} else if (command === 'ab') {
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer')
  if (!values.base || !values.head) throw new Error('ab needs --base and --head')
  if (!values.scenario?.length) throw new Error('ab needs at least one --scenario')
  const batch = resolveBatch({
    repo: resolve(values.repo),
    base: values.base,
    head: values.head,
    scenarios,
    repeat,
    setupPath: resolve(ROOT, values.setup),
    ...(values.name ? { name: values.name } : {}),
  })
  if (values.foreground) await runBatch(batch)
  else {
    const { unit, record, log } = launchUnit(batch)
    console.log(`started ${unit}\nwatch: systemctl --user is-active ${unit}  (then read ${record})\nprogress: pnpm eval ab --status ${batch.name}\nlog: ${log}`)
  }
} else if (command === 'preflight') {
  const result = await preflight({
    repo: resolve(values.repo),
    commit: values.commit,
    setupPath: resolve(ROOT, values.setup),
    scenario: scenarios[0]!,
  })
  process.exitCode = result.ok ? 0 : 1
} else if (command === 'report') {
  if (values.from !== 'runs' && values.from !== 'results') throw new Error('--from must be runs or results')
  console.log(table(values.from === 'results' ? readPublished(join(ROOT, 'results')) : readRuns(join(ROOT, 'runs'))))
} else if (command === 'export') {
  console.log(`exported ${exportResults(join(ROOT, 'runs'), join(ROOT, 'results'))} results to results/`)
} else if (command === 'rescore') {
  const dir = join(ROOT, 'runs')
  const ids = positionals.length > 1 ? positionals.slice(1) : readdirSync(dir).filter((n) => /^\d{8}t/.test(n))
  for (const id of ids) {
    const result = await rescore(join(dir, id))
    if (!result) {
      console.log(`${id}: no scorecard, skipped`)
      continue
    }
    const card = result.scorecard
    const real = Object.entries(card.toolErrorDetail.real).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
    const benign = Object.entries(card.toolErrorDetail.benign).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
    const found = findings(card).map((c) => `${c.name} (${c.detail})`).join('; ') || 'none'
    console.log(`${id}: ${result.pass ? 'pass' : 'FAIL'} · real errors ${real} · benign ${benign} · findings ${found}`)
  }
} else {
  console.error(
    'Usage: pnpm eval run --commit <sha> [--setup FILE] [--scenario NAME] [--repeat N] [--keep] | pnpm eval ab --base <sha> --head <sha> --scenario NAME… [--repeat N] [--setup FILE] [--name LABEL] [--foreground] | pnpm eval ab --status <name> | pnpm eval preflight --commit <sha> [--setup FILE] [--scenario NAME] | pnpm eval report [--from results] | pnpm eval export | pnpm eval rescore [id…]',
  )
  process.exit(1)
}
