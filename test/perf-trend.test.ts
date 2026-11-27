import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PerfRecord } from '../src/perf/batch.ts'
import { measuringCode, readBatches, trend } from '../src/perf/trend.ts'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const pass = (commit: string, repeat: number, cold: number | { error: string }) => ({
  commit, repeat, at: `2026-11-2${repeat}`, seconds: 60, load1Start: 1, load1End: 1, cpuBusy: 0.1, gate: 'ready' as const, waitedSec: 0,
  sample: { firstLoad: { cold: typeof cold === 'number' ? { transcriptMs: cold } : cold }, memory: { jsHeapUsedMB: 20 + repeat } },
})
const record = (evalCommit: string, samples: ReturnType<typeof pass>[], commits = [a]) =>
  ({ name: 'x', commits, repeat: 2, evalCommit, small: false, dates: {}, pid: 1, startedAt: evalCommit, complete: true, seeds: {}, samples }) as unknown as PerfRecord

test('the trend keeps eval versions apart, shows a failed metric as a gap, and prefers a local record over its export', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue-trend-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q')
    const commit = (file: string, text: string) => {
      mkdirSync(join(root, 'src/perf'), { recursive: true })
      writeFileSync(join(root, file), text)
      git('add', '-A')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file)
      return git('rev-parse', 'HEAD')
    }
    const first = commit('src/perf/browser.ts', 'measure 1')
    const reportOnly = commit('src/perf/report.ts', 'report 2')
    const measuring = commit('src/perf/browser.ts', 'measure 2')
    assert.equal(measuringCode(root, first), measuringCode(root, reportOnly))
    assert.notEqual(measuringCode(root, first), measuringCode(root, measuring))

    mkdirSync(join(root, 'runs'))
    mkdirSync(join(root, 'results/perf'), { recursive: true })
    const save = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value))
    save('runs/perf-one.json', record(first, [pass(a, 1, { error: 'timed out' }), pass(a, 2, { error: 'timed out' })]))
    save('runs/perf-two.json', record(reportOnly, [pass(b, 1, 100), pass(b, 2, 140)], [b]))
    save('runs/perf-three.json', record(measuring, [pass(b, 1, 90)], [b]))
    // An export of `one` loses to the local record; `four` exists only as an export.
    save('results/perf/one.json', { commits: [a], evalCommit: first, seeds: {}, samples: [] })
    // A pass that failed before any sample exports as empty metrics; an option-shaped pin never reaches git.
    save('results/perf/five.json', { commits: [a], evalCommit: first, seeds: {}, samples: [
      { commit: a, repeat: 1, load1Start: 1, load1End: 1, cpuBusy: null, gate: 'ready', waitedSec: 0, metrics: { 'memory.jsHeapUsedMB': 30 } },
      { commit: a, repeat: 2, load1Start: 1, load1End: 1, cpuBusy: null, gate: 'ready', waitedSec: 0, metrics: {} },
    ] })
    save('results/perf/bad.json', { commits: ['--output=/tmp/x'], evalCommit: first, seeds: {}, samples: [] })
    save('results/perf/four.json', { commits: [a], evalCommit: first, seeds: {}, samples: [{
      commit: a, repeat: 1, load1Start: 1, load1End: 1, cpuBusy: null, gate: 'ready', waitedSec: 0,
      metrics: { 'firstLoad.cold': null, 'firstLoad.warm.coverMs': null, 'memory.jsHeapUsedMB': 30 },
    }] })

    const batches = readBatches(root)
    assert.deepEqual(batches.map((batch) => [batch.name, batch.source]).sort(),
      [['five', 'export'], ['four', 'export'], ['one', 'local'], ['three', 'local'], ['two', 'local']])
    assert.deepEqual(batches.find((batch) => batch.name === 'four')!.passes[0]!.errors, { 'firstLoad.cold': null })

    const dates: Record<string, string> = { [a]: '2026-10-26', [b]: '2026-11-27' }
    // `one` alone in a version: its timed-out cold load still shows as failed when the chart asks for it.
    const alone = trend(batches.filter((batch) => batch.name === 'one'), { version: () => 'v', date: () => undefined }, ['firstLoad.cold.transcriptMs'])
    assert.deepEqual(alone[0]!.points[0]!.metrics['firstLoad.cold.transcriptMs'], { median: null, min: null, max: null, n: 0, failed: 2 })

    const versions = trend(batches, { version: (e) => measuringCode(root, e), date: (c) => dates[c] })
    assert.equal(versions.length, 2)
    const [old, current] = versions
    assert.deepEqual(new Set(old!.evalCommits), new Set([first, reportOnly]))
    assert.deepEqual(current!.evalCommits, [measuring])
    assert.deepEqual(old!.points.map((p) => [p.batch, p.commit]).sort(), [['five', a], ['four', a], ['one', a], ['two', b]])
    assert.deepEqual(old!.points.find((p) => p.batch === 'five')!.metrics['memory.jsHeapUsedMB'], { median: 30, min: 30, max: 30, n: 1, failed: 1 })

    const one = old!.points.find((p) => p.batch === 'one')!
    // Both passes timed out: no value, two failures, never a zero.
    assert.deepEqual(one.metrics['firstLoad.cold.transcriptMs'], { median: null, min: null, max: null, n: 0, failed: 2 })
    assert.deepEqual(one.metrics['memory.jsHeapUsedMB'], { median: 21.5, min: 21, max: 22, n: 2, failed: 0 })
    const two = old!.points.find((p) => p.batch === 'two')!
    assert.deepEqual(two.metrics['firstLoad.cold.transcriptMs'], { median: 120, min: 100, max: 140, n: 2, failed: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
