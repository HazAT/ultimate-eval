import assert from 'node:assert/strict'
import test from 'node:test'
import { median, percentile } from '../src/perf/metrics.ts'

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
