/**
 * pnpm eval run --commit <sha> [--setup setups/today.json] [--scenario recipe-v2] [--repeat N] [--repo PATH] [--keep] [--export]
 * pnpm eval report [--from results]   the matrix from runs/, or from the published results/
 * pnpm eval export   write results/<id>.json, the cleaned-up public result of every finished run
 * pnpm eval rescore [run id…]   rebuild scorecards of finished runs from what they stored
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readdirSync } from 'node:fs'
import { exportResults } from './export.ts'
import { readPublished, readRuns, table } from './report.ts'
import { rescore } from './rescore.ts'
import { ROOT, run } from './run.ts'
import { findings } from './score.ts'

const { values, positionals } = parseArgs({
  options: {
    commit: { type: 'string', default: 'main' },
    setup: { type: 'string', default: 'setups/today.json' },
    scenario: { type: 'string', default: 'recipe-v2' },
    repeat: { type: 'string', default: '1' },
    repo: { type: 'string', default: join(homedir(), 'Projects/ultimate') },
    keep: { type: 'boolean', default: false },
    // Only a run meant for publishing writes to the tracked results/; smoke and verification runs stay in runs/.
    export: { type: 'boolean', default: false },
    from: { type: 'string', default: 'runs' },
  },
  allowPositionals: true,
})

const command = positionals[0]
if (command === 'run') {
  const repeat = Number(values.repeat)
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer')
  for (let i = 0; i < repeat; i++) {
    const result = await run({
      repo: resolve(values.repo),
      commit: values.commit,
      setupPath: resolve(ROOT, values.setup),
      scenario: values.scenario,
      keep: values.keep,
      repeat: { index: i + 1, total: repeat },
    })
    // A cancel (Ctrl+C, TERM, the Bench surface's Cancel) stops the remaining repeats too.
    if (result.status === 'cancelled') break
  }
  console.log(`\n${table(readRuns(join(ROOT, 'runs')))}`)
  if (values.export) console.log(`\nexported ${exportResults(join(ROOT, 'runs'), join(ROOT, 'results'))} results to results/`)
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
    'Usage: pnpm eval run --commit <sha> [--setup FILE] [--scenario NAME] [--repeat N] [--keep] [--export] | pnpm eval report [--from results] | pnpm eval export | pnpm eval rescore [id…]',
  )
  process.exit(1)
}
