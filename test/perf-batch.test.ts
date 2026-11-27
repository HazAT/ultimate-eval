import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PerfRecord } from '../src/perf/batch.ts'
import type { Sample } from '../src/perf/browser.ts'
import { exportPerf } from '../src/perf/export.ts'
import { cpuBusy, gateDecision, loadGate } from '../src/perf/load.ts'
import { flatten, groupPerf, perfReport } from '../src/perf/report.ts'

const commit = 'a'.repeat(40)
const evalCommit = 'b'.repeat(40)
const hidden = '/home/private https://private.example/session'
const sample: Sample = {
  firstBuildMs: 0,
  firstLoad: { cold: { transcriptMs: 10, dclMs: 20, fcpMs: 15, transferBytes: 50 }, warm: { error: hidden } },
  sendToResponse: { userMs: 1, answerMs: 2 },
  ttft: { serverPrepMs: 1, streamToPaintMs: 2, totalMs: 3 },
  switch: { cold: [{ id: 314, round: 0, settledMs: 60, longMs: 55 }, { id: 315, round: 0, settledMs: 80, longMs: 65 }], warm: [] },
  streaming: { longtask: { count: 0, totalMs: 0, p95Ms: null }, longAnimationFrame: null, rafGapsOver33Ms: 0 },
  memory: { jsHeapUsedMB: 20, nodes: 25, jsEventListeners: 2 },
  reconnect: { startedAt: 1000, readyAt: 1100, firstEventAt: 1200, readyToEventMs: 100, outageMs: 200, restartBuildMs: { error: hidden } },
  keypress: { error: hidden },
}
const record: PerfRecord = {
  name: 'small', commits: [commit], repeat: 1, evalCommit, small: true, dates: { [commit]: '2026-01-02' },
  pid: 1, startedAt: 'start', finishedAt: 'end', complete: true,
  seeds: { [commit]: { sidebar: 50, turns: 100, entryCounts: [2, 2], toolCounts: [1, 1], seconds: 9 } },
  samples: [{ commit, repeat: 1, at: 'start', seconds: 60, load1Start: 4, load1End: 5, cpuBusy: 0.3, gate: 'ready', waitedSec: 15, sample }],
}

test('flattens metrics and distinguishes errors from missing observations', () => {
  const flat = flatten(sample)
  assert.deepEqual(flat.firstBuildMs, { value: 0, error: false })
  assert.deepEqual(flat['firstLoad.cold.transcriptMs'], { value: 10, error: false })
  assert.deepEqual(flat['firstLoad.warm.transcriptMs'], { value: null, error: true })
  assert.deepEqual(flat['switch.cold.settledMs'], { value: 70, error: false })
  assert.deepEqual(flat['switch.warm.settledMs'], { value: null, error: false })
  assert.deepEqual(flat['streaming.longtask.p95Ms'], { value: null, error: false })
  assert.deepEqual(flat['reconnect.restartBuildMs'], { value: null, error: true })
  assert.deepEqual(flat['keypress.duration.p95Ms'], { value: null, error: true })
  assert.equal(flat['reconnect.startedAt'], undefined)
})

test('reports separate eval commits and sizes, preserving first supplied commit order', () => {
  const another = { ...record, evalCommit: 'c'.repeat(40), name: 'other' }
  const large = { ...record, small: false, name: 'large' }
  assert.deepEqual(groupPerf([record, another, record, large]), [[record, record], [another], [large]])
  const firstCommit = 'd'.repeat(40)
  const report = perfReport([{ ...record, commits: [firstCommit, commit], dates: { ...record.dates, [firstCommit]: '2026-01-01' } }, another])
  assert.match(report, /firstLoad.cold.transcriptMs\ncommit[^\n]+\nddddddd 2026-01-01[^\n]+\naaaaaaa 2026-01-02\s+10.00\s+10.00–10.00\s+1\s+0/)
  assert.match(report, /firstLoad.warm.transcriptMs\ncommit[^\n]+\nddddddd[^\n]+\naaaaaaa 2026-01-02\s+—\s+—\s+0\s+1/)
  assert.equal((report.match(/^eval /gm) ?? []).length, 2)
})

test('load gate waits in 15-second steps, opens at 4, and times out after 30 minutes', async () => {
  assert.equal(gateDecision(4, 0), 'ready')
  assert.equal(gateDecision(4.01, 29 * 60_000), 'wait')
  assert.equal(gateDecision(4.01, 30 * 60_000), 'timeout')
  let elapsed = 0
  const readers = {
    load1: () => elapsed < 30_000 ? 5 : 4,
    now: () => elapsed,
    wait: async (ms: number) => { assert.equal(ms, 15_000); elapsed += ms },
  }
  assert.deepEqual(await loadGate(undefined, readers), { gate: 'ready', load1Start: 4, waitedSec: 30 })
  elapsed = 0
  assert.deepEqual(await loadGate(undefined, { ...readers, load1: () => 5 }), { gate: 'timeout', load1Start: 5, waitedSec: 1800 })
  assert.equal(cpuBusy({ total: 100, idle: 40 }, { total: 150, idle: 65 }), 0.5)
})

test('perf export drops private details and refuses leaked paths and URLs in public fields before writing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ue-perf-export-test-'))
  const out = join(tmp, 'results')
  try {
    assert.throws(() => exportPerf('small', { ...record, evalCommit: '/home/private' }, out), /export refused/)
    assert.throws(() => exportPerf('small', { ...record, commits: ['https://private.example/session'] }, out), /export refused/)
    assert.equal(existsSync(out), false)
    exportPerf('small', { ...record, error: hidden }, out)
    const text = readFileSync(join(out, 'small.json'), 'utf8')
    assert.doesNotMatch(text, /private|https?:|314|startedAt|entryIds/)
    const pub = JSON.parse(text)
    assert.deepEqual(Object.keys(pub), ['commits', 'evalCommit', 'seeds', 'samples'])
    assert.deepEqual(pub.seeds[commit], { sidebar: 50, turns: 100, entryCounts: [2, 2], toolCounts: [1, 1] })
    assert.equal(pub.samples[0].metrics['switch.cold.settledMs'], 70)
    assert.equal(pub.samples[0].metrics['firstLoad.warm.transcriptMs'], null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
