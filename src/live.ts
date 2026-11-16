/**
 * `runs/<id>/live.json`: where a run in progress stands, for the Bench surface to read without touching the run. It is
 * replaced atomically (written to a temporary file, then renamed) at every phase and every watchdog tick, and removed
 * once `result.json` is written. One left behind without a result and without a live `pid` is an abandoned run.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** This call's place in a sequence of `pnpm eval run` calls (an A/B script), from `EVAL_PLAN=2/4`. */
  plan?: { index: number; total: number }
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

/** `EVAL_PLAN=i/N`: where this call stands in a script looping over several calls; anything else is no plan. */
export function planOf(value: string | undefined): Live['plan'] {
  const m = /^(\d+)\/(\d+)$/.exec(value?.trim() ?? '')
  const [index, total] = [Number(m?.[1]), Number(m?.[2])]
  return m && index >= 1 && index <= total ? { index, total } : undefined
}

/** At most this many runs are reported: one runner runs at a time, a few at most. */
const STATUS_RUNS = 10

/**
 * The runs in progress, for other instances and agents: each `runs/<id>/live.json` without a result whose runner
 * `alive` confirms. Cheap and bounded: one small file per unfinished run, nothing else. Times are epoch ms.
 */
export function status(runsDir: string, alive: (pid: unknown) => boolean) {
  const ids = existsSync(runsDir)
    ? readdirSync(runsDir).filter((n) => /^\d{8}t\d{4}-/.test(n) && !existsSync(join(runsDir, n, 'result.json')))
    : []
  const runs = ids.flatMap((id) => {
    const path = join(runsDir, id, 'live.json')
    try {
      if (statSync(path).size > 1024 * 1024) return []
      const live = JSON.parse(readFileSync(path, 'utf8')) as Live
      if (!alive(live.pid)) return []
      return [{
        id: live.id,
        scenario: live.scenario,
        commit: live.commit,
        phase: live.phase,
        repeat: live.repeat,
        ...(live.plan ? { plan: live.plan } : {}),
        startedAt: live.launchedAt,
        updatedAt: live.updatedAt,
      }]
    } catch {
      return []
    }
  })
  return { runs: runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, STATUS_RUNS) }
}

/** The newest run in progress as one step, for Ultimate's `status/status`: its A/B plan place, else its repeat; null when none. */
export function progress(runsDir: string, alive: (pid: unknown) => boolean): { label: string; index: number; total: number } | null {
  const r = status(runsDir, alive).runs[0]
  return r ? { label: 'run', ...(r.plan ?? r.repeat) } : null
}

/** Replace `path` atomically, so a reader never sees half a file. */
export function writeLive(path: string, live: Live) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...live, said: live.said.slice(-8).map((s) => ({ ...s, text: s.text.slice(0, 600) })) }))
  renameSync(tmp, path)
}
