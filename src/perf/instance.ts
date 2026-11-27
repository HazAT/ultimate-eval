/** One scratch Ultimate per commit; snapshot once, then restore before each measured repeat. */
import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneUltimate, initRepo, resolveCommit, startInstance, stopGroup } from '../run.ts'
import { startFake } from './fake.ts'
import type { FakeOptions } from './fake.ts'
import { seedAnswer } from './seed.ts'

export async function perfInstance(commit: string, options: {
  fake?: FakeOptions
  signal?: AbortSignal
  log?: (line: string) => void
} = {}) {
  const { signal, log = console.log } = options
  const repo = join(homedir(), 'Projects', 'ultimate')
  const sha = resolveCommit(repo, commit)
  const tmp = mkdtempSync(join(tmpdir(), `ue-perf-${sha.slice(0, 7)}-`))
  const project = join(tmp, 'project')
  const userHome = join(tmp, 'user')
  const settings = join(userHome, '.ultimate')
  const home = join(settings, 'projects', 'p')
  const cache = join(tmp, 'seed')
  const groups = new Set<ChildProcess>()
  let fake: Awaited<ReturnType<typeof startFake>> | undefined
  let stopped = false
  let snapshotReady = false
  let port: number | undefined

  const killGroups = () => {
    for (const { pid } of groups) if (pid && pid > 1) try { process.kill(-pid, 'SIGKILL') } catch {}
  }
  process.on('exit', killGroups)
  const halt = async () => {
    for (const child of groups) {
      await stopGroup(child)
      groups.delete(child)
    }
  }
  const stop = async () => {
    if (stopped) return
    stopped = true
    try {
      await halt()
    } finally {
      killGroups()
      process.off('exit', killGroups)
      try { await fake?.close() } finally { rmSync(tmp, { recursive: true, force: true }) }
    }
  }

  try {
    signal?.throwIfAborted()
    const clone = cloneUltimate(repo, sha, tmp, log)
    const fixture = join(tmp, 'fixture')
    mkdirSync(fixture)
    writeFileSync(join(fixture, 'fixture.txt'), 'A stable tool result for the performance benchmark.\n')
    initRepo(fixture, project, 'Performance fixture')
    mkdirSync(settings, { recursive: true })
    const json = (name: string, value: unknown) => writeFileSync(join(settings, name), JSON.stringify(value))
    json('settings.json', { onboarding: false, extensions: { disable: ['update', 'claude-code'] } })
    json('model-families.json', { recent: { families: Object.fromEntries(
      ['default', 'fast', 'tiny', 'review', 'design'].map((name) => [name, { model: 'fake/fake-1' }]),
    ) } })
    json('trust.json', { [project]: true })
    fake = await startFake(options.fake ?? { chunkMs: 0, answer: seedAnswer })
    // Do not inherit provider keys, credential-store variables, or the real HOME.
    const env = {
      PATH: process.env.PATH,
      HOME: userHome,
      PI_CODING_AGENT_DIR: fake.agentDir,
      TAILSCALE_COMMAND: '/nonexistent',
    }
    const start = async () => {
      if (stopped) throw new Error('performance instance is stopped')
      signal?.throwIfAborted()
      const started = await startInstance({
        clone, root: project, home, userHome, groups, port, env, log, cancelled: () => !!signal?.aborted,
      })
      port = Number(new URL(started.base).port)
      return started.base
    }
    const base = await start()
    const seedPath = join(dirname(home), 'seed.json')
    const copy = (from: string, to: string) => execFileSync('cp', ['-a', from, to], { cwd: tmp })
    return {
      base, home, userHome, fake,
      async restart() {
        await halt()
        await start()
      },
      async snapshot() {
        if (snapshotReady) throw new Error('performance seed already snapshotted')
        await halt()
        mkdirSync(cache)
        copy(seedPath, join(cache, 'seed.json'))
        copy(home, join(cache, 'home'))
        snapshotReady = true
      },
      async restore() {
        if (!snapshotReady) throw new Error('snapshot the performance seed before restoring it')
        await halt()
        rmSync(home, { recursive: true, force: true })
        cpSync(join(cache, 'seed.json'), seedPath)
        copy(join(cache, 'home'), home)
        await start()
      },
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
