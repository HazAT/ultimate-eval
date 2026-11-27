import assert from 'node:assert/strict'
import test from 'node:test'
import { keypressStats, liveRowVisible, median, percentile } from '../src/perf/metrics.ts'

test('performance percentiles interpolate sorted samples without changing the input', () => {
  const values = [40, 10, 30, 20]
  assert.equal(median(values), 25)
  assert.equal(percentile(values, 0.95), 38.5)
  assert.equal(percentile(values, 0), 10)
  assert.equal(percentile(values, 1), 40)
  assert.deepEqual(values, [40, 10, 30, 20])
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(percentile([7], 0.95), 7)
  assert.equal(percentile([], 0.95), null)
})

test('keypress statistics require exactly one painted observation for each physical key', () => {
  const keys = Array.from({ length: 30 }, (_, i) => i)
  const { count, duration } = keypressStats(keys, 30)
  assert.equal(count, 30)
  assert.equal(duration.medianMs, 14.5)
  assert.equal(duration.p95Ms.toFixed(2), '27.55')
  assert.throws(() => keypressStats([...keys, 9], 30), /31 keydowns/)
  assert.throws(() => keypressStats([null, ...keys.slice(1)], 30), /29 of 30 physical keys/)
})

test('a visible row must be in the live app, uncovered, and intersect the scroll viewport', () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100 })
  const bounds = { top: 10, bottom: 100, left: 0, right: 100 }
  const row = {
    isConnected: true,
    closest: <E extends Element>(_selector: string): E | null => null,
    checkVisibility: () => true,
    getBoundingClientRect: () => rect(5, 15),
  }
  assert.equal(liveRowVisible(row, bounds, false), true)
  assert.equal(liveRowVisible(row, bounds, true), false)
  assert.equal(liveRowVisible({ ...row, closest: <E extends Element>(selector: string) => selector === '#resume' ? {} as E : null }, bounds, false), false)
  assert.equal(liveRowVisible({ ...row, checkVisibility: () => false }, bounds, false), false)
  assert.equal(liveRowVisible(row, bounds, false, rect(0, 10)), false)
})
