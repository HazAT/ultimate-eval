/**
 * Preflight: before any paid run, prove that a commit can run a setup at all, without calling a model. Clone and
 * install the commit, start a scratch Ultimate on the scenario's fixture with the setup's user home, then check that
 * the event stream connects (whichever protocol the commit speaks), that every agent definition and overlay loads,
 * that each role runs on the model its setup gives it, that those models have a login, and that the supervisor logged
 * no warning or error. Stops it and deletes everything after.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Instance } from './api.ts'
import { cloneUltimate, initRepo, removeTemp, resolveCommit, ROOT, startInstance, stopGroup } from './run.ts'
import { logProblems } from './score.ts'
import { expected, readSetup, seedUserHome } from './setup.ts'

export type Preflight = { commit: string; ok: boolean; protocol?: string; problems: string[]; seconds: number }

type Definitions = {
  definitions: { name: string; runs?: { family?: string; model?: ModelRef } }[]
  errors: { name: string; path: string; error: string }[]
  /** The main model: what the default family runs on (it inherits it). */
  main: { model?: ModelRef }
}
type ModelRef = { provider: string; modelId: string }
type Models = { models: { provider: string; id: string; available?: boolean }[] }

export async function preflight(options: {
  repo: string
  commit: string
  setupPath: string
  scenario: string
  log?: (line: string) => void
}): Promise<Preflight> {
  const log = options.log ?? ((line: string) => console.log(line))
  const startedAt = Date.now()
  const commit = resolveCommit(options.repo, options.commit)
  const setup = readSetup(options.setupPath)
  const tmp = `/tmp/ue-preflight-${commit.slice(0, 7)}-${Math.random().toString(36).slice(2, 6)}`
  const problems: string[] = []
  const groups = new Set<ChildProcess>()
  let instance: Instance | undefined
  log(`preflight ${commit.slice(0, 10)}, setup ${setup.name}, scenario ${options.scenario}`)
  try {
    const clone = cloneUltimate(options.repo, commit, tmp, log)
    const project = join(tmp, 'project')
    initRepo(join(ROOT, 'scenarios', options.scenario, 'fixture'), project, 'Recipe list')
    const userHome = join(tmp, 'user')
    const home = join(userHome, '.ultimate', 'projects', 'project')
    seedUserHome(userHome, [project], setup)
    const started = await startInstance({ clone, root: project, home, userHome, groups, cancelled: () => false, log })

    instance = new Instance(started.base)
    await instance.watch(1, ['board'])
    await instance.open(30_000).catch((e) => problems.push(`event stream: ${e instanceof Error ? e.message : e}`))
    if (!instance.downSince && !instance.doc(1, 'board')) {
      // The snapshot of a subscribed document follows the stream's first event; give it a moment.
      for (let i = 0; i < 20 && !instance.doc(1, 'board'); i++) await instance.changed(250)
      if (!instance.doc(1, 'board')) problems.push(`event stream (${instance.protocol}): no board document`)
    }

    const { definitions, errors, main } = await instance.action<Definitions>('subagents', 'definitions', null)
    for (const e of errors) problems.push(`agent ${e.name} (${e.path}): ${e.error}`)
    const { models } = await instance.get<Models>('/api/models')
    for (const role of Object.keys(setup.roles)) {
      const want = expected(setup, role)!.model
      const runsOn = definitions.find((d) => d.name === role)?.runs
      const ran = runsOn?.model ?? (runsOn?.family === 'default' ? main.model : undefined)
      const runs = ran && `${ran.provider}/${ran.modelId}`
      if (!definitions.some((d) => d.name === role)) problems.push(`role ${role}: no such agent definition`)
      else if (runs !== want) problems.push(`role ${role}: runs on ${runs ?? 'nothing'}, setup says ${want}`)
    }
    for (const [family, { model }] of Object.entries(setup.families)) {
      const found = models.find((m) => `${m.provider}/${m.id}` === model)
      if (!found) problems.push(`family ${family}: unknown model ${model}`)
      else if (found.available === false) problems.push(`family ${family}: no login for ${model}`)
    }

    const supervisor = join(home, 'supervisor.log')
    for (const line of logProblems(existsSync(supervisor) ? readFileSync(supervisor, 'utf8') : ''))
      problems.push(`supervisor: ${line.slice(0, 300)}`)
    if (started.exited) problems.push('the scratch supervisor exited')
  } catch (error) {
    problems.push(String(error instanceof Error ? error.message : error))
  } finally {
    instance?.close()
    for (const child of groups) await stopGroup(child).catch(() => {})
    removeTemp(tmp)
  }
  const result = {
    commit,
    ok: !problems.length,
    ...(instance?.protocol ? { protocol: instance.protocol } : {}),
    problems,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }
  log(`preflight ${commit.slice(0, 10)}: ${result.ok ? 'ok' : 'FAILED'} (${result.protocol ?? 'no'} stream, ${result.seconds} s)`)
  for (const p of problems) log(`  ${p}`)
  return result
}
