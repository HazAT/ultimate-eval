import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abRun, batchName, formatStatus, planBatch, runBatch, writeRecord } from '../src/ab.ts'
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
    unit: 'ue-ab-x', pid: 1, startedAt: '2026-11-26T00:00:00Z', total: 2, preflight: [], runs: [run], complete: false,
  }
  writeRecord(path, record)
  assert.deepEqual(readdirSync(join(dir, 'runs')), ['ab-x.json']) // atomic: no .tmp left behind
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).complete, false)
  // A unit gone with the record incomplete is a dead batch, not a finished one.
  assert.match(formatStatus({ unit: 'ue-ab-x', active: 'failed', record }), /1\/2 runs[\s\S]*head hhhhhhh 0\/1 pass[\s\S]*it died/)
  const failed = { ...record, complete: true, error: 'preflight failed: bbbbbbb: agent ultimate: Unknown field: codeMode' }
  assert.doesNotMatch(formatStatus({ unit: 'ue-ab-x', active: 'inactive', record: failed }), /died/)
  assert.match(formatStatus({ unit: 'ue-ab-x', active: 'inactive', record: failed }), /stopped: preflight failed/)
  // A foreground batch has no unit: its own process says whether it lives.
  const foreground = { ...record, unit: undefined, pid: process.pid }
  assert.doesNotMatch(formatStatus({ unit: 'ue-ab-x', active: 'inactive', record: foreground }), /died/)
})

test('a batch stops before the next paid run on a failed preflight, a run that could not run, or a bad setup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ue-ab-'))
  const options = { repo: '/r', base: 'b', head: 'h', scenarios: ['s'], repeat: 2, setupPath: '/s.json', name: 'x' }
  const ok = async ({ commit }: { commit: string }) => ({ commit, ok: true, problems: [], seconds: 1 })
  const ran: string[] = []
  const run = async ({ commit }: { commit: string }) => {
    ran.push(commit)
    return { id: `r${ran.length}`, status: 'error', pass: false, failure: { detail: 'Error: pnpm install failed\n  at …' } }
  }
  const errored = await runBatch(options, { run: run as never, preflight: ok, path: join(dir, 'a.json') })
  assert.deepEqual(ran, ['b'])
  assert.equal(errored.complete, true)
  assert.equal(errored.error, 'base run r1 could not run: Error: pnpm install failed')

  const refused = async ({ commit }: { commit: string }) =>
    ({ commit, ok: commit === 'b', problems: commit === 'b' ? [] : ['agent ultimate: Unknown field: codeMode'], seconds: 1 })
  const blocked = await runBatch(options, { run: run as never, preflight: refused, path: join(dir, 'b.json') })
  assert.deepEqual(ran, ['b']) // nothing more spent
  assert.equal(blocked.error, 'preflight failed: h: agent ultimate: Unknown field: codeMode')

  const throws = async () => { throw new Error('/s.json: a setup needs name') }
  const bad = await runBatch(options, { run: run as never, preflight: throws, path: join(dir, 'c.json') })
  assert.equal(JSON.parse(readFileSync(join(dir, 'c.json'), 'utf8')).complete, true)
  assert.equal(bad.error, '/s.json: a setup needs name')

  // A name is one batch's: a second one with it refuses to start.
  await assert.rejects(runBatch(options, { run: run as never, preflight: ok, path: join(dir, 'a.json') }), /EEXIST/)
})
