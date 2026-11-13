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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Instance, openQuestions } from './api.ts'
import type { Message } from './api.ts'
import { decide, shapeAnswers, SIM_EFFORT, SIM_MODEL, SIM_PROMPT_SHA, turnPrompt } from './sim.ts'
import type { Card, Decision, Said } from './sim.ts'
import { coordinatorsOf, writeLive } from './live.ts'
import type { Live, Phase } from './live.ts'
import { answerText, gateFailed, readExpect, score } from './score.ts'
import type { Scorecard } from './score.ts'
import { readSetup, seedUserHome, verifyModels } from './setup.ts'

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
  /** This run's place in a `--repeat`, for the live view. */
  repeat?: { index: number; total: number }
  log?: (line: string) => void
}

type Failure = {
  reason: 'timeout' | 'hang' | 'crash' | 'cancelled' | 'error'
  atMin: number
  detail: string
  stuck: unknown
}
/** The event stream down this long means the core is dead or stuck restarting. */
const DOWN_MIN = 2

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

/** Send `signal` to process group `pgid`; false when the group has no member left. */
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false // ESRCH: the whole group is gone
  }
}

/**
 * Stop a detached child's whole process group, by the real pid we spawned it with (never a pattern): TERM, then KILL
 * for any member still there after 15 s, whether or not the leader has exited.
 */
export async function stopGroup(child: ChildProcess | undefined) {
  const pgid = child?.pid
  if (!pgid || pgid <= 1) return
  if (!signalGroup(pgid, 'SIGTERM')) return
  for (let i = 0; i < 60 && signalGroup(pgid, 0); i++) await new Promise((d) => setTimeout(d, 250))
  signalGroup(pgid, 'SIGKILL')
}

/**
 * A short hash over every file of a folder, following links (a variant links its base's fixture), so a run pins the
 * exact scenario. `expect.json` is how runs are scored, not what Ultimate is given: it stays out, so adding an
 * expectation keeps a scenario's earlier runs in its matrix row.
 */
export function folderSha(dir: string) {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (d === dir && name === 'expect.json') continue
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else hash.update(path.slice(dir.length)).update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

/**
 * The definition each conversation was configured from: its `ultimate.agent-profile` document (subagents/api.ts), whose
 * `definition` is the real definition name, never a display label; an agent made on the fly has none. Read from a
 * stopped home's database only, so no storage internals are touched while the server runs. The newest revision wins.
 */
export function agentProfiles(database: string): Record<number, string> {
  if (!existsSync(database)) return {}
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const out: Record<number, string> = {}
    const rows = db
      .prepare(
        `select d.owner_id as owner, r.content as content from documents d join document_revisions r on r.document_id = d.id
         where d.kind = '"ultimate.agent-profile"' and d.scope_kind = 'conversation' and r.kind = 'base' order by r.seq`,
      )
      .all() as { owner: number; content: string }[]
    for (const row of rows) {
      const profile = JSON.parse(row.content) as { definition?: string }
      if (profile.definition) out[row.owner] = profile.definition
      else delete out[row.owner]
    }
    return out
  } finally {
    db.close()
  }
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
  const expect = readExpect(scenarioDir)
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
  /** Where the run stood the last time the instance answered: kept for every failure, errors included. */
  let lastStuck: unknown = null
  const result: Record<string, unknown> = { id, pins, startedAt: new Date(startedAt).toISOString() }

  // Where the run stands, for the Bench surface: replaced at each phase and tick, removed with the result.
  const livePath = join(out, 'live.json')
  const live: Live = {
    id,
    pid: process.pid,
    phase: 'preparing',
    commit,
    setup: setup.name,
    scenario: options.scenario,
    repeat: options.repeat ?? { index: 1, total: 1 },
    launchedAt,
    budgetMin: BUDGET_MIN,
    updatedAt: Date.now(),
    said: [],
    busy: [],
    coordinators: [],
    open: 0,
  }
  let finished = false
  const publish = (update: Partial<Live> & { phase?: Phase } = {}) => {
    if (finished) return // a late side read must not bring back a removed live.json
    Object.assign(live, update, { updatedAt: Date.now() })
    try {
      writeLive(livePath, live)
    } catch (e) {
      log(`writing live.json: ${e}`)
    }
  }
  publish()

  // Ctrl+C or a TERM ends the run as a failure: the loop sees `cancelled`, the finally block cleans up. A second
  // signal kills the groups at once and leaves.
  let cancelled = false
  const cancel = new AbortController()
  const groups = new Set<ChildProcess>()
  const onSignal = (signal: NodeJS.Signals) => {
    if (cancelled) {
      for (const child of groups) if (child.pid && child.pid > 1) signalGroup(child.pid, 'SIGKILL')
      process.exit(130)
    }
    cancelled = true
    cancel.abort()
    log(`${signal}: stopping the run`)
    instance?.close()
  }
  const killOnExit = () => {
    for (const child of groups) if (child.pid && child.pid > 1) signalGroup(child.pid, 'SIGKILL')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('exit', killOnExit)

  try {
    // The Ultimate under test: a shared clone writes nothing into the source repository.
    const clone = join(tmp, 'ultimate')
    sh('git', ['clone', '-q', '--shared', '--no-checkout', options.repo, clone], '/')
    sh('git', ['checkout', '-q', '--detach', commit], clone)
    sh('git', ['remote', 'remove', 'origin'], clone)
    publish({ phase: 'installing' })
    log('installing packages')
    sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], clone, cleanEnv())
    // The card at this commit sends a multi answer as a list (ce22290 and later) or joined with ", " (before).
    const joinMulti = !readFileSync(join(clone, 'extensions/questions/server.ts'), 'utf8').includes(
      'Array.isArray(a.answer)',
    )

    // The project: the fixture as a git repository with one commit and no remote.
    const project = join(tmp, 'project')
    cpSync(join(scenarioDir, 'fixture'), project, { recursive: true, dereference: true })
    const git = (...args: string[]) => sh('git', args, project)
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.name=Eval User', '-c', 'user.email=eval@example.com', 'commit', '-q', '-m', 'Recipe list')
    const fixtureCommit = git('rev-parse', 'HEAD')

    const home = join(tmp, 'home')
    const userHome = join(tmp, 'user')
    mkdirSync(home)
    seedUserHome(userHome, project, setup)

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    publish({ phase: 'starting', url: base })
    log(`starting ${base}`)
    if (cancelled) throw new Error('cancelled')
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
    groups.add(server)
    let exited = false
    server.on('exit', () => (exited = true))
    for (let i = 0; ; i++) {
      if (cancelled) throw new Error('cancelled')
      if (exited) throw new Error('the scratch server exited while starting')
      if (i > 480) throw new Error('the scratch server did not become ready in 2 minutes')
      const ok = await fetch(`${base}/api/models`).then((r) => r.ok, () => false)
      if (ok) break
      await new Promise((d) => setTimeout(d, 250))
    }

    publish({ phase: 'opening' })
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
    // The hang clock: what Ultimate said, a real change of its state, or something the user did. Simulated-user calls
    // that only wait are no progress.
    let lastNews = Date.now()
    let calls = 0
    let nudges = 0
    let refreshing: Promise<void> | undefined

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
        // Bounded by the run's budget and by cancellation, so a slow call cannot outlive either.
        const left = firstPromptAt ? firstPromptAt + BUDGET_MIN * 60000 - Date.now() : 180_000
        const call = await decide(
          prompt,
          simCwd,
          AbortSignal.any([cancel.signal, AbortSignal.timeout(Math.max(1000, left))]),
        )
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
    lastNews = firstPromptAt
    await instance.submit(ultimateId, opening.call.decision.text)
    said.push({ at: firstPromptAt, who: 'you', text: opening.call.decision.text })
    opening.record.applied = 'sent'
    log(`you: ${opening.call.decision.text}`)
    publish({ phase: 'running', firstPromptAt, ultimate: ultimateId, said })

    for (;;) {
      await instance.changed(15_000)
      const now = Date.now()
      const elapsedMin = (now - firstPromptAt) / 60000
      if (cancelled) {
        failure = { reason: 'cancelled', atMin: elapsedMin, detail: 'interrupted', stuck: lastStuck }
        break
      }
      if (exited) {
        failure = { reason: 'crash', atMin: elapsedMin, detail: 'the scratch supervisor exited', stuck: lastStuck }
        break
      }
      if (instance.downSince && now - instance.downSince > DOWN_MIN * 60000) {
        failure = {
          reason: 'crash',
          atMin: elapsedMin,
          detail: `the core served no event stream for ${DOWN_MIN} minutes`,
          stuck: lastStuck,
        }
        break
      }
      if (instance.downSince) continue // restarting: wait for it to come back
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

      // Where it stands, kept from the last time the instance answered, for whatever failure comes.
      lastStuck = {
        busy: instance.conversations.filter((c) => c.busy).map((c) => ({ id: c.id, title: c.title, label: c.label })),
        open: openQuestions(instance.doc(1, 'board')).map((m) => ({ id: m.id, from: m.from, text: m.text.slice(0, 300) })),
        lastSaid: said.at(-1),
        lastProgressMin: Math.round(((now - Math.max(instance.lastProgress, lastNews)) / 60000) * 10) / 10,
      }
      publish({
        said,
        busy: (lastStuck as { busy: Live['busy'] }).busy,
        open: (lastStuck as { open: unknown[] }).open.length,
      })
      // The coordinators come from the root's history, read on the side: the watchdog never waits for the live view.
      if (!refreshing) {
        const watched = instance
        refreshing = watched
          .history(1)
          .then((root) => publish({ coordinators: coordinatorsOf(root, watched.conversations) }))
          .catch(() => {})
          .finally(() => (refreshing = undefined))
      }
      if (elapsedMin > BUDGET_MIN) {
        failure = { reason: 'timeout', atMin: elapsedMin, detail: `not done in ${BUDGET_MIN} minutes`, stuck: lastStuck }
        break
      }
      const quiet = (now - Math.max(instance.lastProgress, lastNews)) / 60000
      if (quiet > HANG_MIN) {
        failure = { reason: 'hang', atMin: elapsedMin, detail: `nothing new for ${HANG_MIN} minutes`, stuck: lastStuck }
        break
      }

      const open = openQuestions(instance.doc(1, 'board'))
      const idle = !instance.busy()
      const due = news || (idle && now - lastSimAt > 3 * 60000) || (open.length > 0 && now - lastSimAt > 5 * 60000)
      if (!due) continue
      if (calls >= MAX_SIM_CALLS) {
        failure = { reason: 'error', atMin: elapsedMin, detail: `${MAX_SIM_CALLS} simulated user calls`, stuck: lastStuck }
        break
      }
      const turn = await ask(false)
      // The budget is absolute: a simulated-user call that ends past it cannot finish the run.
      const afterMin = (Date.now() - firstPromptAt) / 60000
      if (afterMin > BUDGET_MIN) {
        failure = { reason: 'timeout', atMin: afterMin, detail: `not done in ${BUDGET_MIN} minutes`, stuck: lastStuck }
        break
      }
      if (cancelled) continue
      if (!turn) continue
      const { decision } = turn.call
      log(`sim: ${decision.action} (${decision.why})`)
      if (decision.action === 'message') {
        if (turn.quietMinutes >= 5) nudges++
        lastNews = Date.now()
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
          lastNews = Date.now()
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
          simDone = { atMin: afterMin, why: decision.why }
          turn.record.applied = 'done'
          break
        }
        turn.record.applied = 'done refused: still busy or cards open'
      }
    }

    if (cancelled) throw new Error('cancelled')
    publish({ phase: 'collecting', busy: [] })
    // Collect everything over the API before the server stops; each request is bounded, a dead core yields none.
    const conversations = instance.conversations
    const histories: Record<number, Awaited<ReturnType<Instance['history']>>> = {}
    for (const c of conversations) {
      histories[c.id] = await instance.history(c.id).catch(() => [])
      writeFileSync(join(out, 'transcripts', `${c.id}.json`), JSON.stringify(histories[c.id]))
    }
    const board = instance.doc<{ messages: Message[] }>(1, 'board') ?? { messages: [] }
    writeFileSync(join(out, 'transcripts', 'board.json'), JSON.stringify(board, null, 1))
    writeFileSync(join(out, 'transcripts', 'conversations.json'), JSON.stringify(conversations, null, 1))
    instance.close()
    instance = undefined
    await stopGroup(server)
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'trace.sqlite', 'trace.sqlite-wal', 'supervisor.log'])
      if (existsSync(join(home, name))) {
        mkdirSync(join(out, 'home'), { recursive: true })
        cpSync(join(home, name), join(out, 'home', name))
      }
    const agents = agentProfiles(join(home, 'state.sqlite'))
    const card: Scorecard = score(
      { conversations, histories, board, ultimate: ultimateId, firstPromptAt, agents },
      FEATURE_WORDS,
      expect,
    )
    if (expect.untouched) {
      const changed = git('diff', '--name-only', fixtureCommit, 'main').split('\n').filter(Boolean)
      const churned = expect.untouched.paths.filter((p) => changed.includes(p))
      card.checks.push({
        name: 'no unrelated files changed',
        pass: !churned.length,
        gate: expect.untouched.gate,
        detail: churned.length ? `changed: ${churned.join(', ')}` : `changed only: ${changed.join(', ') || 'nothing'}`,
      })
    }

    // The hidden acceptance spec, on a fresh checkout of the project's main.
    publish({ phase: 'accepting', coordinators: coordinatorsOf(histories[1] ?? [], conversations) })
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
    if (cancelled) throw new Error('cancelled')
    const site = spawn(process.execPath, ['serve.js'], {
      cwd: checkout,
      detached: true,
      stdio: 'ignore',
      env: { ...cleanEnv(), PORT: String(sitePort) },
    })
    groups.add(site)
    let acceptance
    try {
      for (let i = 0; i < 40; i++) {
        if (await fetch(`http://127.0.0.1:${sitePort}/`).then((r) => r.ok, () => false)) break
        await new Promise((d) => setTimeout(d, 250))
      }
      acceptance = await accept(`http://127.0.0.1:${sitePort}/`, join(out, 'screenshots'), cancel.signal)
    } finally {
      await stopGroup(site)
    }
    writeFileSync(join(out, 'acceptance.json'), JSON.stringify(acceptance, null, 2))

    const passed = (name: string) => acceptance.checks.find((c: { name: string }) => c.name === name)?.pass === true
    const features = Object.fromEntries(
      Object.entries(FEATURES as Record<string, string[]>).map(([f, checks]) => [f, checks.every(passed)]),
    )
    const models = verifyModels(setup, card.modelsByRole)
    const simCost = simLog.reduce((n, s) => n + (s.costUsd ?? 0), 0)
    const allLanded = card.coordinators.length > 0 && card.coordinators.every((c) => c.landed)
    if (cancelled) throw new Error('cancelled')
    const pass =
      !failure &&
      Object.values(models).every((m) => m.status !== 'mismatch') &&
      !!simDone &&
      acceptance.checks.every((c: { pass: boolean }) => c.pass) &&
      projectTests.pass &&
      allLanded &&
      !gateFailed(card) &&
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
      models,
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
    result.status = cancelled ? 'cancelled' : 'error'
    result.failure = {
      reason: result.status,
      ...(firstPromptAt ? { atMin: (Date.now() - firstPromptAt) / 60000 } : {}),
      detail: String(error instanceof Error ? error.stack : error),
      stuck: failure?.stuck ?? lastStuck,
    }
    log(`error: ${String(error)}`)
  } finally {
    instance?.close()
    // Each step on its own: one failing must not keep the others from running.
    for (const child of groups) await stopGroup(child).catch((e) => log(`stopping ${child.pid}: ${e}`))
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('exit', killOnExit)
    try {
      writeFileSync(join(out, 'sim.json'), JSON.stringify({ said, calls: simLog }, null, 1))
      result.simCostUsd = Math.round(simLog.reduce((n, s) => n + (s.costUsd ?? 0), 0) * 100) / 100
      result.finishedAt = new Date().toISOString()
      writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
      finished = true
      rmSync(livePath, { force: true })
    } catch (e) {
      log(`writing results: ${e}`)
    }
    if (!options.keep) {
      rmSync(tmp, { recursive: true, force: true })
      for (const dir of claudeProjects(tmp)) rmSync(dir, { recursive: true, force: true })
    }
    log(`run ${id}: ${result.pass ? 'PASS' : `FAIL (${result.status})`} → ${out}`)
  }
  return result
}
