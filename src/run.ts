/**
 * One eval run: a temporary clone of the Ultimate commit under test, a fresh project from the scenario's fixture (no
 * remote), a supervised scratch Ultimate on its own home and an empty user home (logins are read in place through
 * the real HOME, never copied), the simulated user talking to it over HTTP, then the hidden acceptance spec on the
 * project's `main`. Everything temporary lives in /tmp/ue-run-<id> and is deleted afterwards, including Claude Code's
 * session logs for those paths.
 */
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Instance, openQuestions } from './api.ts'
import type { Message } from './api.ts'
import { decide, shapeAnswers, SIM_EFFORT, SIM_MODEL, SIM_PROMPT_SHA, turnPrompt } from './sim.ts'
import type { Card, Decision, Said } from './sim.ts'
import { answerText, score } from './score.ts'
import type { Scorecard } from './score.ts'
import { expected, readSetup, seedUserHome } from './setup.ts'

export const ROOT = resolve(import.meta.dirname, '..')
export const BUDGET_MIN = 30
export const HANG_MIN = 10
const MAX_SIM_CALLS = 60

export type RunOptions = {
  repo: string
  commit: string
  setupPath: string
  scenario: string
  keep?: boolean
  log?: (line: string) => void
}

type Failure = { reason: 'timeout' | 'hang' | 'crash' | 'error'; atMin: number; detail: string; stuck: unknown }

const sh = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** The process environment without anything of the Ultimate this runs under. */
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ULTIMATE_'))) as NodeJS.ProcessEnv

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stop a detached child by its own process group (its real pid, never a pattern). */
async function stopGroup(child: ChildProcess) {
  const pid = child.pid
  if (!pid || !alive(pid)) return
  process.kill(-pid, 'SIGTERM')
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((d) => setTimeout(d, 250))
  if (alive(pid)) process.kill(-pid, 'SIGKILL')
}

/** A short hash over every file of a folder, so a run pins the exact scenario. */
export function folderSha(dir: string) {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name)
      if (readdirSync(d, { withFileTypes: true }).find((e) => e.name === name)!.isDirectory()) walk(path)
      else hash.update(path.slice(dir.length)).update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

/** Claude Code keeps a session folder per working directory; these are the run's. */
const claudeProjects = (tmp: string) => {
  const dir = join(homedir(), '.claude/projects')
  const prefix = tmp.replace(/[^a-zA-Z0-9]/g, '-')
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => join(dir, n)) : []
}

export async function run(options: RunOptions) {
  const log = options.log ?? ((line: string) => console.log(line))
  const setup = readSetup(options.setupPath)
  const scenarioDir = join(ROOT, 'scenarios', options.scenario)
  const scenarioText = readFileSync(join(scenarioDir, 'scenario.md'), 'utf8')
  const { accept, FEATURES, FEATURE_WORDS } = await import(join(scenarioDir, 'accept.ts'))
  const commit = sh('git', ['rev-parse', `${options.commit}^{commit}`], options.repo)
  const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase()}-${commit.slice(0, 7)}-${Math.random().toString(36).slice(2, 6)}`
  const tmp = `/tmp/ue-run-${id}`
  const out = join(ROOT, 'runs', id)
  mkdirSync(join(out, 'transcripts'), { recursive: true })
  mkdirSync(join(out, 'screenshots'), { recursive: true })
  const pins = {
    ultimateCommit: commit,
    scenario: options.scenario,
    scenarioSha: folderSha(scenarioDir),
    setup: setup.name,
    setupSha: createHash('sha256').update(readFileSync(options.setupPath)).digest('hex').slice(0, 12),
    families: setup.families,
    roles: setup.roles,
    simModel: `claude-code/${SIM_MODEL}`,
    simEffort: SIM_EFFORT,
    simPromptSha: SIM_PROMPT_SHA,
    evalCommit: (() => {
      try {
        return sh('git', ['rev-parse', 'HEAD'], ROOT)
      } catch {
        return undefined
      }
    })(),
  }
  log(`run ${id}: ultimate ${commit.slice(0, 10)}, setup ${setup.name}, scenario ${options.scenario}`)

  const simLog: { at: number; prompt?: string; decision?: Decision; costUsd?: number; ms?: number; error?: string; applied?: string }[] = []
  const said: Said[] = []
  let server: ChildProcess | undefined
  let instance: Instance | undefined
  let failure: Failure | undefined
  let simDone: { atMin: number; why: string } | undefined
  let firstPromptAt = 0
  const launchedAt = Date.now()
  let startedAt = launchedAt
  let ultimateId = 0
  const result: Record<string, unknown> = { id, pins, startedAt: new Date(startedAt).toISOString() }

  const cleanupOnExit = () => {
    if (server?.pid && alive(server.pid)) process.kill(-server.pid, 'SIGKILL')
  }
  process.once('exit', cleanupOnExit)

  try {
    // The Ultimate under test: a shared clone writes nothing into the source repository.
    const clone = join(tmp, 'ultimate')
    sh('git', ['clone', '-q', '--shared', '--no-checkout', options.repo, clone], '/')
    sh('git', ['checkout', '-q', '--detach', commit], clone)
    sh('git', ['remote', 'remove', 'origin'], clone)
    log('installing packages')
    sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], clone, cleanEnv())
    // The card at this commit sends a multi answer as a list (ce22290 and later) or joined with ", " (before).
    const joinMulti = !readFileSync(join(clone, 'extensions/questions/server.ts'), 'utf8').includes(
      'Array.isArray(a.answer)',
    )

    // The project: the fixture as a git repository with one commit and no remote.
    const project = join(tmp, 'project')
    cpSync(join(scenarioDir, 'fixture'), project, { recursive: true })
    const git = (...args: string[]) => sh('git', args, project)
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.name=Eval User', '-c', 'user.email=eval@example.com', 'commit', '-q', '-m', 'Recipe list')

    const home = join(tmp, 'home')
    const userHome = join(tmp, 'user')
    mkdirSync(home)
    seedUserHome(userHome, project, setup)

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    log(`starting ${base}`)
    server = spawn(process.execPath, ['bin/ultimate.ts', project, '--port', String(port), '--no-open'], {
      cwd: clone,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...cleanEnv(),
        ULTIMATE_HOME: home,
        ULTIMATE_USER_HOME: userHome,
        ULTIMATE_NO_OPEN: '1',
      },
    })
    let exited = false
    server.on('exit', () => (exited = true))
    for (let i = 0; ; i++) {
      if (exited) throw new Error('the scratch server exited while starting')
      if (i > 480) throw new Error('the scratch server did not become ready in 2 minutes')
      const ok = await fetch(`${base}/api/models`).then((r) => r.ok, () => false)
      if (ok) break
      await new Promise((d) => setTimeout(d, 250))
    }

    instance = new Instance(base)
    await instance.watch(1, ['board'])
    await instance.open()
    ultimateId = await instance.action<number>('subagents', 'standing', { name: 'ultimate' })
    log(`@ultimate is #${ultimateId}`)

    const simCwd = join(tmp, 'sim')
    let seenEntry = 0
    const seenMessages = new Set<number>()
    const shown = new Set<string>()
    let lastSimAt = 0
    let lastNews = Date.now()
    let calls = 0
    let nudges = 0

    const ask = async (opening: boolean) => {
      const board = instance!.doc<{ messages: Message[] }>(1, 'board')
      const cards: Card[] = openQuestions(board).map((m) => ({
        id: m.id,
        from: m.from,
        text: m.text,
        questions: m.questions ?? [],
      }))
      const minutes = firstPromptAt ? Math.round((Date.now() - firstPromptAt) / 60000) : 0
      const quietMinutes = Math.round((Date.now() - lastNews) / 60000)
      const prompt = turnPrompt({
        scenario: scenarioText,
        said,
        cards,
        busy: instance!.busy(),
        minutes,
        quietMinutes,
        opening,
      })
      calls++
      lastSimAt = Date.now()
      const at = Date.now()
      try {
        const call = await decide(prompt, simCwd)
        const record: (typeof simLog)[number] = { at, prompt, decision: call.decision, costUsd: call.costUsd, ms: call.ms }
        simLog.push(record)
        return { call, cards, quietMinutes, record }
      } catch (error) {
        simLog.push({ at, prompt, error: String(error) })
        return undefined
      }
    }

    // The opening message.
    const opening = await ask(true)
    if (!opening || opening.call.decision.action !== 'message')
      throw new Error(`the simulated user did not open: ${JSON.stringify(opening?.call.decision)}`)
    firstPromptAt = Date.now()
    startedAt = firstPromptAt
    await instance.submit(ultimateId, opening.call.decision.text)
    said.push({ at: firstPromptAt, who: 'you', text: opening.call.decision.text })
    opening.record.applied = 'sent'
    log(`you: ${opening.call.decision.text}`)

    for (;;) {
      await instance.changed(15_000)
      const now = Date.now()
      if (exited) {
        failure = { reason: 'crash', atMin: (now - firstPromptAt) / 60000, detail: 'the scratch server exited', stuck: null }
        break
      }
      // What the user sees: every message to the user (cards and one-way), and @ultimate's final answers.
      let news = false
      for (const message of instance.doc<{ messages: Message[] }>(1, 'board')?.messages ?? []) {
        if (message.to !== 'user' || seenMessages.has(message.id)) continue
        seenMessages.add(message.id)
        shown.add(message.text.trim())
        const from = message.from === ultimateId ? 'Ultimate' : `Ultimate's branch #${message.from}`
        said.push({
          at: message.at,
          who: 'ultimate',
          text: `(${from}, card ${message.id}${message.reply ? ', waits for your answer' : ''}) ${message.text}`,
        })
        news = true
        log(`card ${message.id} from #${message.from}: ${message.text.slice(0, 120).replace(/\n/g, ' ')}`)
      }
      const entries = await instance.history(ultimateId).catch(() => [])
      for (const entry of entries) {
        if (entry.id <= seenEntry) continue
        seenEntry = entry.id
        const m = entry.model?.[0]
        const text = answerText(entry).trim()
        if (m?.role === 'assistant' && m.stopReason === 'stop' && text && !shown.has(text)) {
          said.push({ at: m.timestamp ?? now, who: 'ultimate', text })
          news = true
          log(`ultimate: ${text.slice(0, 160).replace(/\n/g, ' ')}`)
        }
      }
      if (news) lastNews = now

      const elapsedMin = (now - firstPromptAt) / 60000
      const stuck = () => ({
        busy: instance!.conversations.filter((c) => c.busy).map((c) => ({ id: c.id, title: c.title, label: c.label })),
        open: openQuestions(instance!.doc(1, 'board')).map((m) => ({ id: m.id, from: m.from, text: m.text.slice(0, 300) })),
        lastSaid: said.at(-1),
      })
      if (elapsedMin > BUDGET_MIN) {
        failure = { reason: 'timeout', atMin: elapsedMin, detail: `not done in ${BUDGET_MIN} minutes`, stuck: stuck() }
        break
      }
      const quiet = (now - Math.max(instance.lastChange, lastSimAt, lastNews)) / 60000
      if (quiet > HANG_MIN) {
        failure = { reason: 'hang', atMin: elapsedMin, detail: `nothing new for ${HANG_MIN} minutes`, stuck: stuck() }
        break
      }

      const open = openQuestions(instance.doc(1, 'board'))
      const idle = !instance.busy()
      const due = news || (idle && now - lastSimAt > 3 * 60000) || (open.length > 0 && now - lastSimAt > 5 * 60000)
      if (!due) continue
      if (calls >= MAX_SIM_CALLS) {
        failure = { reason: 'error', atMin: elapsedMin, detail: `${MAX_SIM_CALLS} simulated user calls`, stuck: stuck() }
        break
      }
      const turn = await ask(false)
      if (!turn) continue
      const { decision } = turn.call
      log(`sim: ${decision.action} (${decision.why})`)
      if (decision.action === 'message') {
        if (turn.quietMinutes >= 5) nudges++
        await instance.submit(ultimateId, decision.text)
        said.push({ at: Date.now(), who: 'you', text: decision.text })
        turn.record.applied = 'sent'
        log(`you: ${decision.text}`)
      } else if (decision.action === 'answer') {
        const card = turn.cards.find((c) => c.id === decision.messageId)
        if (!card) {
          turn.record.applied = `no open card ${decision.messageId}`
          said.push({ at: Date.now(), who: 'ultimate', text: `(system) Card ${decision.messageId} is not open.` })
          continue
        }
        try {
          const args = card.questions.length
            ? {
                messageId: card.id,
                answers: shapeAnswers(card, decision.answers, joinMulti),
                ...(decision.note ? { note: decision.note } : {}),
              }
            : { messageId: card.id, text: decision.note ?? decision.answers.map((a) => a.answer).flat().join('\n') }
          await instance.action('questions', 'answer', args)
          turn.record.applied = `answered ${JSON.stringify(args)}`
          said.push({
            at: Date.now(),
            who: 'you',
            text: `(answered card ${card.id}) ${decision.answers.map((a) => `${a.question}: ${[a.answer].flat().join(', ')}`).join('; ')}${decision.note ? ` Note: ${decision.note}` : ''}`,
          })
          log(`you answered card ${card.id}`)
        } catch (error) {
          turn.record.applied = `refused: ${String(error)}`
          said.push({ at: Date.now(), who: 'ultimate', text: `(system) Your answer to card ${card.id} was refused: ${String(error).slice(0, 300)}` })
          log(`answer refused: ${String(error)}`)
        }
      } else if (decision.action === 'done') {
        if (!instance.busy() && !openQuestions(instance.doc(1, 'board')).length) {
          simDone = { atMin: elapsedMin, why: decision.why }
          turn.record.applied = 'done'
          break
        }
        turn.record.applied = 'done refused: still busy or cards open'
      }
    }

    // Collect everything over the API before the server stops.
    const conversations = instance.conversations
    const histories: Record<number, Awaited<ReturnType<Instance['history']>>> = {}
    for (const c of conversations) {
      histories[c.id] = await instance.history(c.id).catch(() => [])
      writeFileSync(join(out, 'transcripts', `${c.id}.json`), JSON.stringify(histories[c.id]))
    }
    const board = instance.doc<{ messages: Message[] }>(1, 'board') ?? { messages: [] }
    writeFileSync(join(out, 'transcripts', 'board.json'), JSON.stringify(board, null, 1))
    writeFileSync(join(out, 'transcripts', 'conversations.json'), JSON.stringify(conversations, null, 1))
    const card: Scorecard = score(
      { conversations, histories, board, ultimate: ultimateId, firstPromptAt },
      FEATURE_WORDS,
    )
    instance.close()
    instance = undefined
    await stopGroup(server)
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'trace.sqlite', 'trace.sqlite-wal', 'supervisor.log'])
      if (existsSync(join(home, name))) {
        mkdirSync(join(out, 'home'), { recursive: true })
        cpSync(join(home, name), join(out, 'home', name))
      }

    // The hidden acceptance spec, on a fresh checkout of the project's main.
    const remotes = git('remote')
    const checkout = join(tmp, 'accept')
    sh('git', ['clone', '-q', project, checkout], '/')
    const mainLog = git('log', '--oneline', 'main')
    let projectTests: { pass: boolean; output: string }
    try {
      projectTests = { pass: true, output: sh('npm', ['test'], checkout, cleanEnv()) }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      projectTests = { pass: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
    writeFileSync(join(out, 'project-tests.txt'), projectTests.output)
    const sitePort = await freePort()
    const site = spawn(process.execPath, ['serve.js'], {
      cwd: checkout,
      detached: true,
      stdio: 'ignore',
      env: { ...cleanEnv(), PORT: String(sitePort) },
    })
    let acceptance
    try {
      for (let i = 0; i < 40; i++) {
        if (await fetch(`http://127.0.0.1:${sitePort}/`).then((r) => r.ok, () => false)) break
        await new Promise((d) => setTimeout(d, 250))
      }
      acceptance = await accept(`http://127.0.0.1:${sitePort}/`, join(out, 'screenshots'))
    } finally {
      await stopGroup(site)
    }
    writeFileSync(join(out, 'acceptance.json'), JSON.stringify(acceptance, null, 2))

    const passed = (name: string) => acceptance.checks.find((c: { name: string }) => c.name === name)?.pass === true
    const features = Object.fromEntries(
      Object.entries(FEATURES as Record<string, string[]>).map(([f, checks]) => [f, checks.every(passed)]),
    )
    const modelCheck = Object.fromEntries(
      ['ultimate', 'coordinator'].map((role) => {
        const want = expected(setup, role)?.model
        const ran = card.modelsByRole[role] ?? []
        return [role, { expected: want, ran, ok: ran.length > 0 && ran.every((m) => m === want) }]
      }),
    )
    const workerRan = Object.entries(card.modelsByRole)
      .filter(([role]) => !['ultimate', 'coordinator', 'lander', 'other'].includes(role))
      .flatMap(([, models]) => models)
    const simCost = simLog.reduce((n, s) => n + (s.costUsd ?? 0), 0)
    const allLanded = card.coordinators.length > 0 && card.coordinators.every((c) => c.landed)
    const pass =
      !failure &&
      !!simDone &&
      acceptance.checks.every((c: { pass: boolean }) => c.pass) &&
      projectTests.pass &&
      allLanded &&
      !remotes &&
      card.landings.pushed.length === 0
    Object.assign(result, {
      pass,
      status: failure ? failure.reason : simDone ? 'done' : 'stopped',
      failure,
      simDone,
      minutes: Math.round(((Date.now() - firstPromptAt) / 60000) * 10) / 10,
      startupSec: Math.round((firstPromptAt - launchedAt) / 1000),
      features,
      allLanded,
      projectTests: { pass: projectTests.pass },
      acceptance: acceptance.checks,
      noRemote: !remotes,
      mainLog: mainLog.split('\n'),
      models: { ...modelCheck, worker: { expected: expected(setup, 'worker')?.model, ran: [...new Set(workerRan)] } },
      answerShape: joinMulti ? 'joined' : 'list',
      sim: {
        calls: simLog.length,
        costUsd: Math.round(simCost * 100) / 100,
        improvised: simLog.filter((s) => s.decision && 'improvised' in s.decision && s.decision.improvised).length,
        nudges,
        refusedAnswers: simLog.filter((s) => s.applied?.startsWith('refused')).length,
      },
      scorecard: card,
    })
  } catch (error) {
    result.pass = false
    result.status = 'error'
    result.failure = { reason: 'error', detail: String(error instanceof Error ? error.stack : error) }
    log(`error: ${String(error)}`)
  } finally {
    instance?.close()
    if (server) await stopGroup(server)
    process.off('exit', cleanupOnExit)
    writeFileSync(join(out, 'sim.json'), JSON.stringify({ said, calls: simLog }, null, 1))
    result.finishedAt = new Date().toISOString()
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    if (!options.keep) {
      rmSync(tmp, { recursive: true, force: true })
      for (const dir of claudeProjects(tmp)) rmSync(dir, { recursive: true, force: true })
    }
    log(`run ${id}: ${result.pass ? 'PASS' : `FAIL (${result.status})`} → ${out}`)
  }
  return result
}
