import { readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const LIMIT_MS = 30 * 60_000
const STEP_MS = 15_000

export function gateDecision(load1: number, waitedMs: number) {
  if (load1 <= 4) return 'ready'
  return waitedMs >= LIMIT_MS ? 'timeout' : 'wait'
}

export function load1() {
  const value = Number.parseFloat(readFileSync('/proc/loadavg', 'utf8'))
  if (!Number.isFinite(value)) throw new Error('could not read 1-minute load from /proc/loadavg')
  return value
}

type Cpu = { total: number; idle: number }
export function cpu() {
  // user and nice already include the guest counters; iowait isn't busy CPU time.
  const fields = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0]!.trim().split(/\s+/).slice(1, 9).map(Number)
  if (fields.length !== 8 || !fields.every(Number.isFinite)) throw new Error('could not read CPU counters from /proc/stat')
  return { total: fields.reduce((sum, n) => sum + n, 0), idle: fields[3]! + fields[4]! }
}

export function cpuBusy(start: Cpu, end: Cpu) {
  const total = end.total - start.total
  return total > 0 ? Math.max(0, Math.min(1, 1 - (end.idle - start.idle) / total)) : null
}

type GateReaders = { load1: () => number; now: () => number; wait: (ms: number) => Promise<void> }

export async function loadGate(signal?: AbortSignal, readers: GateReaders = {
  load1, now: () => performance.now(), wait: (ms) => setTimeout(ms, undefined, { signal }),
}) {
  const began = readers.now()
  for (;;) {
    signal?.throwIfAborted()
    const load1Start = readers.load1()
    const elapsed = readers.now() - began
    const gate = gateDecision(load1Start, elapsed)
    if (gate !== 'wait') return { gate, load1Start, waitedSec: elapsed / 1000 } as const
    await readers.wait(Math.min(STEP_MS, LIMIT_MS - elapsed))
  }
}
