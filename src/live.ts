/**
 * `runs/<id>/live.json`: where a run in progress stands, for the Bench surface to read without touching the run. It is
 * replaced atomically (written to a temporary file, then renamed) at every phase and every watchdog tick, and removed
 * once `result.json` is written. One left behind without a result and without a live `pid` is an abandoned run.
 */
import { renameSync, writeFileSync } from 'node:fs'
import type { Entry, Summary } from './api.ts'
import { isLanding } from './score.ts'
import type { Said } from './sim.ts'

export type Phase = 'preparing' | 'installing' | 'starting' | 'opening' | 'running' | 'collecting' | 'accepting'

export type Live = {
  id: string
  /** The runner's process: SIGTERM cancels the run (and the rest of a `--repeat`). */
  pid: number
  phase: Phase
  commit: string
  setup: string
  scenario: string
  repeat: { index: number; total: number }
  launchedAt: number
  /** The first prompt: the budget counts from here. */
  firstPromptAt?: number
  budgetMin: number
  /** The scratch Ultimate under test; watch only. */
  url?: string
  ultimate?: number
  updatedAt: number
  said: Said[]
  busy: { id: number; title?: string; label?: string }[]
  coordinators: { id: number; title?: string; intent?: string; landed: boolean }[]
  /** Cards waiting for the simulated user. */
  open: number
}

/** The coordinators started from the root's history, each with whether a lander note says it landed. */
export function coordinatorsOf(root: Entry[], conversations: Summary[]): Live['coordinators'] {
  const landed = new Set(root.filter(isLanding).map((e) => (e.data as { from?: number }).from))
  const titles = new Map(conversations.map((c) => [c.id, c.title]))
  return root
    .filter((e) => e.kind === 'lineage.branched')
    .map((e) => {
      const { branch, intent } = e.data as { branch: number; intent?: string }
      return { id: branch, title: titles.get(branch), intent, landed: landed.has(branch) }
    })
}

/** Replace `path` atomically, so a reader never sees half a file. */
export function writeLive(path: string, live: Live) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...live, said: live.said.slice(-8).map((s) => ({ ...s, text: s.text.slice(0, 600) })) }))
  renameSync(tmp, path)
}
