import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abRun, batchName, formatStatus, planBatch, writeRecord } from '../src/ab.ts'
import type { AbRecord } from '../src/ab.ts'

test('a batch alternates base and head, repeat pairs per scenario', () => {
  const plan = planBatch('b', 'h', ['s1', 's2'], 2)
  assert.deepEqual(
    plan.map((p) => `${p.arm}:${p.commit}:${p.scenario}`),
    ['base:b:s1', 'head:h:s1', 'base:b:s1', 'head:h:s1', 'base:b:s2', 'head:h:s2', 'base:b:s2', 'head:h:s2'],
  )
  assert.equal(planBatch('b', 'h', ['s'], 1).length, 2)
  assert.equal(batchName(' fix/the thing! '), 'fix-the-thing')
})

test('the record lists each run from its result and says when the batch is complete', () => {
  const run = abRun(
    { arm: 'head', commit: 'h', scenario: 's' },
    { id: 'r1', pass: false, status: 'hang', minutes: 12.5, simCostUsd: 0.3, scorecard: { usage: { totalCostUsd: 1.234 } } },
  )
  assert.deepEqual(run, { id: 'r1', arm: 'head', commit: 'h', scenario: 's', pass: false, status: 'hang', minutes: 12.5, cost: 1.53 })
  // An error before the session has no minutes and no scorecard.
  assert.deepEqual(abRun({ arm: 'base', commit: 'b', scenario: 's' }, { id: 'r0', pass: false, status: 'error' }), {
    id: 'r0', arm: 'base', commit: 'b', scenario: 's', pass: false, status: 'error', cost: 0,
  })

  const dir = mkdtempSync(join(tmpdir(), 'ue-ab-'))
  const path = join(dir, 'runs', 'ab-x.json')
  const record: AbRecord = {
    name: 'x', base: 'b'.repeat(40), head: 'h'.repeat(40), scenarios: ['s'], repeat: 1, setup: 'setups/today.json',
    startedAt: '2026-11-26T00:00:00Z', total: 2, preflight: [], runs: [run], complete: false,
  }
  writeRecord(path, record)
  assert.deepEqual(readdirSync(join(dir, 'runs')), ['ab-x.json']) // atomic: no .tmp left behind
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).complete, false)
  // A unit gone with the record incomplete is a dead batch, not a finished one.
  assert.match(formatStatus({ unit: 'ue-ab-x', active: 'failed', record }), /1\/2 runs[\s\S]*head hhhhhhh 0\/1 pass[\s\S]*the batch died/)
  const failed = { ...record, complete: true, error: 'preflight failed: bbbbbbb: agent ultimate: Unknown field: codeMode' }
  assert.doesNotMatch(formatStatus({ unit: 'ue-ab-x', active: 'inactive', record: failed }), /died/)
  assert.match(formatStatus({ unit: 'ue-ab-x', active: 'inactive', record: failed }), /stopped: preflight failed/)
})
