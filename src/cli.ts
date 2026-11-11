/**
 * pnpm eval run --commit <sha> [--setup setups/today.json] [--scenario recipe-v2] [--repeat N] [--repo PATH] [--keep]
 * pnpm eval report
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readRuns, table } from './report.ts'
import { ROOT, run } from './run.ts'

const { values, positionals } = parseArgs({
  options: {
    commit: { type: 'string', default: 'main' },
    setup: { type: 'string', default: 'setups/today.json' },
    scenario: { type: 'string', default: 'recipe-v2' },
    repeat: { type: 'string', default: '1' },
    repo: { type: 'string', default: join(homedir(), 'Projects/ultimate') },
    keep: { type: 'boolean', default: false },
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
} else if (command === 'report') console.log(table(readRuns(join(ROOT, 'runs'))))
else {
  console.error('Usage: pnpm eval run --commit <sha> [--setup FILE] [--scenario NAME] [--repeat N] [--keep] | pnpm eval report')
  process.exit(1)
}
