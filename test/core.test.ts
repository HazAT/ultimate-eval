import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, heardAnswers, openQuestions } from '../src/api.ts'
import type { Entry, Message } from '../src/api.ts'
import { shapeAnswers } from '../src/sim.ts'
import { commits, errorCategory, findings, gateFailed, score } from '../src/score.ts'
import { groups, median, readPublished, table } from '../src/report.ts'
import { exportResults, scan } from '../src/export.ts'
import { coordinatorsOf, writeLive } from '../src/live.ts'
import type { Live } from '../src/live.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult } from '../src/report.ts'

test('applyOps follows the stream: replace, set, append, splice, delete', () => {
  let doc: unknown = {}
  doc = applyOps(doc, [['r', { messages: [], next: 1 }]] as never)
  doc = applyOps(doc, [
    ['p', ['messages'], 0, 0, [{ id: 1, text: 'Hi', state: 'sent' }]],
    ['s', ['next'], 2],
  ] as never)
  doc = applyOps(doc, [
    ['a', ['messages', 0, 'text'], ' there'],
    ['s', ['messages', 0, 'state'], 'delivered'],
  ] as never)
  assert.deepEqual(doc, { messages: [{ id: 1, text: 'Hi there', state: 'delivered' }], next: 2 })
  doc = applyOps(doc, [['d', ['messages', 0]]] as never)
  assert.deepEqual(doc, { messages: [], next: 2 })
})

test('open questions are delivered, reply-expected messages to the user', () => {
  const m = (over: Partial<Message>): Message => ({ id: 1, from: 5, to: 'user', text: '', at: 0, reply: true, state: 'delivered', ...over })
  const open = openQuestions({
    messages: [m({ id: 1 }), m({ id: 2, state: 'answered' }), m({ id: 3, reply: false }), m({ id: 4, to: 7 })],
  })
  assert.deepEqual(open.map((x) => x.id), [1])
})

test('the user hears @ultimate answers, not those routed to a branch, and waits for the newest while busy', () => {
  const answer = (id: number, text: string): Entry => ({
    id,
    kind: 'message',
    conversationId: 40,
    model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }],
  })
  const text = (e: Entry) => (e.model![0]!.content as { text: string }[])[0]!.text
  const msg = { id: 3, from: 40, to: 96, text: '', at: 0, reply: false, state: 'delivered' }
  const entries = [answer(140, 'I started branch #96'), answer(149, 'Ask the user. My picks: 1a')]
  // Busy, and the routed record not in yet: 149 waits.
  const first = heardAnswers(entries, 0, { messages: [] }, 40, true, text)
  assert.deepEqual(first.answers.map((a) => a.text), ['I started branch #96'])
  assert.equal(first.seen, 140)
  // Next pass: the board routed 149 down to #96, so the user never hears it.
  const board = { messages: [{ ...msg, routed: 149 }] }
  const second = heardAnswers(entries, first.seen, board, 40, false, text)
  assert.deepEqual(second.answers, [])
  assert.equal(second.seen, 149)
  // Another sender's routed id is not @ultimate's.
  assert.equal(heardAnswers(entries, 140, { messages: [{ ...msg, from: 96, routed: 149 }] }, 40, false, text).answers.length, 1)
})

test('a multi answer goes as a list, or joined for a commit before ce22290', () => {
  const card = {
    id: 3,
    from: 5,
    text: '',
    questions: [
      { text: 'Which first?', kind: 'multi' as const, options: [{ label: 'Search' }, { label: 'Favourites' }] },
      { text: 'Go?', kind: 'confirm' as const },
    ],
  }
  const answers = [
    { question: 'Which first?', answer: ['Search', 'Favourites'] },
    { question: 'Go?', answer: 'Yes' },
    { question: 'Not on the card', answer: 'x' },
  ]
  assert.deepEqual(shapeAnswers(card, answers, false), [
    { question: 'Which first?', answer: ['Search', 'Favourites'] },
    { question: 'Go?', answer: 'Yes' },
  ])
  assert.equal(shapeAnswers(card, answers, true)[0]!.answer, 'Search, Favourites')
})

const assistant = (id: number, conversationId: number, model: string, cost: number, extra: object = {}): Entry => ({
  id,
  kind: 'pi.assistant',
  conversationId,
  model: [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      provider: model.split('/')[0],
      model: model.split('/')[1],
      usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 10, totalTokens: 105, cost: { total: cost } },
      ...extra,
    },
  ],
})

test('score matches coordinators to features, counts workers, plans, landings and cost', () => {
  const words = { search: /search/i, favourites: /favou?rite/i }
  const card = score(
    {
      ultimate: 2,
      firstPromptAt: 0,
      // #12 shows a custom label; its definition is what counts. #13 has no record.
      agents: { 12: 'worker' },
      conversations: [
        { id: 1, busy: false },
        { id: 2, busy: false, label: 'agent' },
        { id: 10, busy: false, title: 'Recipe pages alongside search', branchOf: { conversationId: 1, at: 3 } },
        { id: 11, busy: false, title: 'Favourites', branchOf: { conversationId: 1, at: 4 } },
        { id: 12, busy: false, label: 'search implementation', parentConversationId: 10 },
        { id: 13, busy: false, label: 'worker', parentConversationId: 11 },
        { id: 9, busy: false, label: 'lander' },
      ],
      histories: {
        1: [
          { id: 3, kind: 'lineage.branched', conversationId: 1, data: { branch: 10, intent: 'Search' } },
          { id: 4, kind: 'lineage.branched', conversationId: 1, data: { branch: 11, intent: 'Favourites' } },
          { id: 6, kind: 'lineage.note', conversationId: 1, data: { from: 11, text: 'still investigating' } },
          {
            id: 5,
            kind: 'lineage.note',
            conversationId: 1,
            data: { from: 10, sha: 'abc', source: 'lander' },
            model: [{ role: 'user', content: 'Landed', timestamp: 6 * 60000 }],
          },
        ],
        2: [assistant(20, 2, 'claude-code/opus', 1)],
        10: [
          assistant(21, 10, 'claude-code/opus', 2, {
            content: [{ type: 'toolCall', name: 'plan', arguments: { action: 'create' } }],
          }),
          assistant(22, 10, 'claude-code/opus', 0, {
            content: [{ type: 'toolCall', name: 'plan', arguments: { action: 'add' } }],
          }),
        ],
        12: [assistant(23, 12, 'openai-codex/sol', 0.5), { id: 24, kind: 'watchdog.failure', conversationId: 12 }],
        13: [assistant(25, 13, 'x/other', 0)],
      },
      board: {
        messages: [
          { id: 1, from: 2, to: 'user', text: 'Which first?', at: 1000, reply: true, state: 'answered', questions: [{ text: 'q', kind: 'multi' }] },
          { id: 2, from: 'user', to: 2, text: '1a', at: 31000, reply: true, state: 'answered', re: 1 },
        ],
      },
    },
    words,
  )
  assert.deepEqual(card.coordinators.map((c) => [c.id, c.features, c.landed]), [
    [10, ['search'], true],
    [11, ['favourites'], false],
  ])
  assert.deepEqual(card.workers, { total: 2, byCoordinator: { 10: 1, 11: 1 } })
  assert.deepEqual(card.plans, { coordinatorsWithPlan: 1, epics: 1, tasks: 1 })
  assert.equal(card.landings.count, 1)
  assert.equal(card.timing.lastLandingMin, 6)
  assert.equal(card.usage.totalCostUsd, 3.5)
  assert.equal(card.usage.cacheHitRate, 0.8)
  assert.deepEqual(card.modelsByRole, {
    ultimate: ['claude-code/opus'],
    coordinator: ['claude-code/opus'],
    worker: ['openai-codex/sol'],
    unknown: ['x/other'],
  })
  assert.deepEqual(
    { asked: card.questions.asked, multi: card.questions.multi, multiAnswered: card.questions.multiAnswered, wait: card.questions.waitSec },
    { asked: 1, multi: 1, multiAnswered: 1, wait: [30] },
  )
  assert.equal(card.watchdog.failures, 1)
})

test('tool errors: a killed dev server and a server not up yet are benign, the rest are listed', () => {
  const cases: [string, string, string][] = [
    ['bash', '<harness> [error] Command exited with code 143 </harness>', 'killed'],
    ['browser', 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8571/', 'serverNotUp'],
    ['screenshot', 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8734/x', 'serverNotUp'],
  ]
  for (const [tool, text, category] of cases) assert.equal(errorCategory(tool, text), category, text)
  const curl = '000 <harness> [error] Command exited with code 7 </harness>'
  assert.equal(errorCategory('bash', curl, 'curl -s http://127.0.0.1:8080/'), 'serverNotUp')
  assert.equal(errorCategory('bash', curl, 'node build.js'), 'bashExit')
  const more: [string, string, string][] = [
    ['workspace', '<harness> [error] Worktree is dirty: UU app.js </harness>', 'dirtyWorktree'],
    ['read', "ENOENT: no such file or directory, open '/tmp/shots/list.png'", 'enoent'],
    ['bash', 'pass 3 fail 0 <harness> [error] Command exited with code 1 </harness>', 'bashExit'],
    ['codemode', 'ReferenceError: setTimeout is not defined', 'unknown'],
    ['browser', 'Error: locator.waitFor: strict mode violation', 'unknown'],
  ]
  for (const [tool, text, category] of more) assert.equal(errorCategory(tool, text), category, text)
  const bash = (command: string) => commits({ name: 'bash', arguments: { command } })
  assert.equal(bash('git add -A && git commit -qm "x"'), true)
  assert.equal(bash('git -C /tmp/w -c user.name=x commit -m y'), true)
  assert.equal(bash('git log --grep=commit'), false)
  assert.equal(bash('git cat-file -t HEAD^{commit}'), false)
})

test('hard checks: an extra coordinator, the expected card, asked first, a landing that failed a check', () => {
  const words = { search: /search/i }
  const toolResult = (id: number, toolName: string, text: string): Entry => ({
    id,
    kind: 'pi.tool-result',
    conversationId: 10,
    model: [{ role: 'toolResult', toolName, isError: true, content: [{ type: 'text', text }] } as never],
  })
  const commitAt = (id: number, at: number): Entry => ({
    id,
    kind: 'pi.assistant',
    conversationId: 10,
    model: [
      {
        role: 'assistant',
        timestamp: at,
        content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'git add -A && git commit -qm "Search"' } }],
      },
    ],
  })
  const report = (id: number, from: number, outcome: object): Entry => ({
    id,
    kind: 'workspaces.lander-report',
    conversationId: from,
    data: { id: `s${id}`, outcome },
  })
  const data = (cardAt: number) => ({
    ultimate: 2,
    firstPromptAt: 0,
    conversations: [
      { id: 10, busy: false, title: 'Search box' },
      { id: 11, busy: false, title: 'Add a tab icon (favicon)' },
    ],
    histories: {
      1: [
        { id: 3, kind: 'lineage.branched', conversationId: 1, data: { branch: 10, intent: 'Search' } },
        { id: 4, kind: 'lineage.branched', conversationId: 1, data: { branch: 11 } },
        { id: 5, kind: 'lineage.note', conversationId: 1, data: { from: 10, sha: 'a', source: 'lander' } },
        { id: 6, kind: 'lineage.note', conversationId: 1, data: { from: 11, sha: 'b', source: 'lander' } },
      ],
      10: [
        toolResult(20, 'bash', 'Command exited with code 143'),
        toolResult(21, 'workspace', 'Worktree is dirty: UU app.js'),
        commitAt(22, 120_000),
        report(23, 10, { outcome: 'failed', reason: 'it conflicts with main in' }),
        report(24, 10, { outcome: 'failed', reason: 'check failed twice: node scripts/check-docs.js' }),
        // A refused fast-forward is no failed check.
        report(26, 11, { outcome: 'failed', reason: 'main moved; fast-forward refused' }),
        report(25, 10, { outcome: 'landed', sha: 'a' }),
      ],
    },
    board: {
      messages: [{ id: 1, from: 2, to: 'user' as const, text: 'Which?', at: cardAt, reply: true, state: 'answered', questions: [{ text: 'q', kind: 'choice' as const }] }],
    },
  })
  const expect = {
    card: { kind: 'multi', gate: 'finding' as const },
    askedFirst: { gate: 'finding' as const },
    landFailedFirst: { gate: 'pass' as const },
  }
  const card = score(data(60_000), words, expect)
  const by = Object.fromEntries(card.checks.map((c) => [c.name, c]))
  assert.equal(by['every coordinator works on a feature']!.pass, false)
  assert.match(by['every coordinator works on a feature']!.detail!, /#11 Add a tab icon/)
  assert.equal(by['asked a multi card']!.pass, false)
  assert.equal(by['asked before the first commit']!.pass, true)
  assert.equal(by['landed after a failed landing check']!.pass, true)
  assert.match(by['landed after a failed landing check']!.detail!, /check-docs/)
  assert.deepEqual(findings(card).map((c) => c.name), ['every coordinator works on a feature', 'asked a multi card'])
  assert.equal(gateFailed(card), false)
  assert.equal(card.toolErrors, 1)
  assert.deepEqual(card.toolErrorDetail.benign, { killed: 1 })
  assert.deepEqual(card.toolErrorDetail.list.map((e) => [e.conversation, e.entry, e.category]), [[10, 21, 'dirtyWorktree']])

  // Asked only after committing; and with only a conflict failing, the landing check is not met and fails the run.
  const late = data(180_000)
  late.histories[10] = late.histories[10]!.filter((e) => e.id !== 24)
  const lateCard = score(late, words, expect)
  assert.equal(lateCard.checks.find((c) => c.name === 'asked before the first commit')!.pass, false)
  assert.equal(gateFailed(lateCard), true)
})

test('reminder: created, fired, heard after the fire; the board has no pending reply or repeat', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { automationsOf } = await import('../src/run.ts')
  const path = `${mkdtempSync('/tmp/ue-test-')}/state.sqlite`
  const db = new DatabaseSync(path)
  const dream = { id: 'A1', key: 'dream:x', name: 'Dream', createdAt: 0, subscribers: ['@ultimate'], runs: [], fires: 0 }
  const reminder = { id: 'A3', name: 'Remind', createdAt: 60_000, schedule: { kind: 'at', time: 'T' }, subscribers: ['@ultimate'], runs: [], fires: 0 }
  db.exec(`create table documents (id integer primary key, kind text, scope_kind text, owner_id integer);
    create table document_revisions (document_id integer, seq integer, kind text, content text);
    insert into documents values (1, '"ultimate.automations"', 'session', 1);
    insert into document_revisions values (1, 1, 'base', '${JSON.stringify({ next: 2, automations: { A1: dream } })}'),
      (1, 2, 'delta', '${JSON.stringify([['s', ['automations', 'A3'], reminder]])}'),
      (1, 3, 'delta', '${JSON.stringify([['s', ['automations', 'A3', 'fires'], 1], ['s', ['automations', 'A3', 'lastFireAt'], 180_000]])}');`)
  db.close()
  const automations = automationsOf(path)
  assert.deepEqual(automations.map((a) => [a.id, a.fires, a.lastFireAt]), [['A3', 1, 180_000]])

  const say = (id: number, at: number, text: string): Entry => ({
    id,
    kind: 'pi.assistant',
    conversationId: 2,
    model: [{ role: 'assistant', stopReason: 'stop', timestamp: at, content: [{ type: 'text', text }] }],
  })
  const data = (answers: Entry[], messages: Message[]) => ({
    ultimate: 2,
    firstPromptAt: 0,
    conversations: [{ id: 2, busy: false, title: '@ultimate' }],
    histories: { 1: [], 2: answers },
    board: { messages },
    automations,
  })
  const expect = { reminder: { gate: 'pass' as const } }
  const by = (card: ReturnType<typeof score>) => Object.fromEntries(card.checks.map((c) => [c.name, c.pass]))

  // Heard: @ultimate's answer after the fire.
  const heard = score(data([say(5, 30_000, 'Set.'), say(9, 181_000, 'Time to try the search.')], []), {}, expect)
  assert.equal(by(heard)['the user heard from Ultimate after the fire'], true)
  assert.match(heard.checks.find((c) => c.name === 'an automation was created')!.detail!, /A3 at T, wakes @ultimate, created 1 min, 1 fires/)
  assert.deepEqual(heard.automations, { created: 1, fired: 1, fires: 1 })
  assert.equal(gateFailed(heard), false)

  // Nothing after the fire fails the gate; a pending reply and a repeated message are findings.
  const message = (id: number, at: number, extra: Partial<Message> = {}): Message =>
    ({ id, from: 2, to: 'user', text: 'Search landed.', at, reply: false, state: 'delivered', ...extra })
  const silent = score(data([say(5, 30_000, 'Set.')], [message(1, 100_000), message(2, 120_000), message(3, 130_000, { text: 'Which?', reply: true })]), {}, expect)
  const checks = by(silent)
  assert.equal(checks['the user heard from Ultimate after the fire'], false)
  assert.equal(checks['every reply-expected message answered'], false)
  assert.equal(checks['no message sent twice'], false)
  assert.match(silent.checks.find((c) => c.name === 'no message sent twice')!.detail!, /2 repeats 1/)
  assert.equal(gateFailed(silent), true)

  // No automation at all fails every reminder check.
  const none = score({ ...data([], []), automations: [] }, {}, expect)
  assert.deepEqual(
    none.checks.filter((c) => c.gate === 'pass').map((c) => c.pass),
    [false, false, false],
  )
})

test('each configured role is checked against what ran: ok, mismatch or not exercised', async () => {
  const { verifyModels } = await import('../src/setup.ts')
  const setup = {
    name: 't',
    families: { default: { model: 'a/opus' }, fast: { model: 'b/sol' }, tiny: { model: 'b/luna' } },
    roles: { ultimate: 'default', coordinator: 'default', worker: 'fast', scout: 'tiny' },
  }
  const out = verifyModels(setup, { ultimate: ['a/opus'], coordinator: ['a/opus', 'b/sol'], worker: ['b/sol'] })
  assert.deepEqual(
    Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.status])),
    { ultimate: 'ok', coordinator: 'mismatch', worker: 'ok', scout: 'not exercised' },
  )
  assert.equal(
    verifyModels(setup, { unknown: ['x/y'] }).unknown?.status,
    'unverified',
  )
})

test('roles come from agent-profile documents of the stopped home, not display labels', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { agentProfiles } = await import('../src/run.ts')
  const path = `${mkdtempSync('/tmp/ue-test-')}/state.sqlite`
  const db = new DatabaseSync(path)
  db.exec(`create table documents (id integer primary key, kind text, scope_kind text, owner_id integer);
    create table document_revisions (document_id integer, seq integer, kind text, content text);
    insert into documents values (1, '"ultimate.agent-profile"', 'conversation', 12), (2, '"ultimate.agent-profile"', 'conversation', 14),
      (3, '"pi.agent"', 'conversation', 12);
    insert into document_revisions values (1, 5, 'base', '{"definition":"worker"}'), (2, 6, 'base', '{"adhoc":true}'),
      (3, 7, 'base', '{"definition":"nope"}');`)
  db.close()
  assert.deepEqual(agentProfiles(path), { 12: 'worker' })
})

test('report groups by commit, setup and scenario with passes/N and medians', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  const r = (pass: boolean, minutes: number, cost: number, commit = 'aaaaaaaaaaaa'): RunResult => ({
    id: String(Math.random()),
    pass,
    status: pass ? 'done' : 'timeout',
    minutes,
    pins: { ultimateCommit: commit, setup: 'today', scenario: 'recipe-v2', scenarioSha: 'ffffff', simPromptSha: 'x' },
    features: { search: true, favourites: pass },
    scorecard: { usage: { totalCostUsd: cost }, coordinators: [], workers: { total: 0 }, questions: { multi: pass ? 1 : 0, multiAnswered: 0 } },
    sim: { costUsd: 0 },
  })
  const out = table([
    r(true, 20, 10),
    r(false, 30, 12),
    r(true, 24, 8),
    r(true, 10, 5, 'bbbbbbbbbbbb'),
    { ...r(false, 1, 0), status: 'cancelled' },
  ])
  const row = out.split('\n').find((l) => l.startsWith('aaaaaaaaaa'))!
  assert.match(row, /2\/3/)
  assert.match(row, /24\.0/)
  assert.match(row, /10\.00/)
  assert.match(row, /search 3\/3, favourites 2\/3/)
  assert.match(row, /timeout/)
  assert.match(row, / 2\/3 0\/3 /)
  const [a, b] = groups([r(true, 20, 10), r(false, 30, 12), r(true, 10, 5, 'bbbbbbbbbbbb')])
  assert.deepEqual([a!.passes, a!.runs.length, a!.medianMin, a!.medianCost, a!.features], [1, 2, 25, 11, { search: 2, favourites: 1 }])
  assert.equal(a!.failures[0]!.status, 'timeout')
  assert.equal(b!.commit, 'bbbbbbbbbbbb')
})

test('live.json is replaced whole, keeps the last turns, and knows which coordinators landed', () => {
  const root = [
    { id: 1, kind: 'lineage.branched', data: { branch: 7, intent: 'Search' } },
    { id: 2, kind: 'lineage.branched', data: { branch: 9, intent: 'Favourites' } },
    { id: 3, kind: 'lineage.note', data: { from: 9 } },
    { id: 4, kind: 'lineage.note', data: { from: 7, source: 'lander', sha: 'abc' } },
  ] as Entry[]
  const coordinators = coordinatorsOf(root, [{ id: 7, title: 'Add search', busy: false }])
  assert.deepEqual(coordinators, [
    { id: 7, title: 'Add search', intent: 'Search', landed: true },
    { id: 9, title: undefined, intent: 'Favourites', landed: false },
  ])
  const path = join(mkdtempSync(join(tmpdir(), 'ue-live-')), 'live.json')
  const live: Live = {
    id: 'x', pid: 1, phase: 'running', commit: 'c', setup: 's', scenario: 'r', repeat: { index: 2, total: 3 },
    launchedAt: 0, budgetMin: 30, updatedAt: 0, busy: [], coordinators, open: 0,
    said: Array.from({ length: 12 }, (_, i) => ({ at: i, who: 'you' as const, text: `turn ${i} ${'x'.repeat(900)}` })),
  }
  writeLive(path, live)
  const read = JSON.parse(readFileSync(path, 'utf8')) as Live
  assert.equal(read.said.length, 8)
  assert.match(read.said[0]!.text, /^turn 4 /)
  assert.equal(read.said[0]!.text.length, 600)
  assert.equal(live.said.length, 12)
  assert.equal(existsSync(`${path}.tmp`), false)
})

test('export publishes only allowlisted fields of finished runs, and the scan refuses leaks', () => {
  const runs = mkdtempSync(join(tmpdir(), 'ue-export-'))
  const results = join(runs, 'out')
  const raw = {
    id: 'r1',
    pins: { ultimateCommit: 'c0ffee', scenario: 'recipe-v2', scenarioSha: 'aa', setup: 'today', setupSha: 'bb', families: { default: { model: 'm', thinking: 'high', host: 'box.tail1234.ts.net' } }, roles: { worker: 'default' }, simModel: 'm', simPromptSha: 'cc', repo: '/home/someone/Projects/ultimate' },
    pass: false,
    status: 'hang',
    finishedAt: 'x',
    failure: { reason: 'hang', atMin: 12, detail: 'Error at /home/someone/x.ts', stuck: { busy: [{ id: 4, title: 'Ask someone@example.com' }], open: [{ text: 'which colour?' }], lastSaid: 'blue', lastProgressMin: 10 } },
    minutes: 12,
    features: { detail: true },
    acceptance: [{ name: 'opens a recipe', pass: true, detail: 'http://127.0.0.1:4000/recipes/1' }],
    mainLog: ['abc Add search'],
    sim: { calls: 3, costUsd: 0.1, improvised: 1, nudges: 0, refusedAnswers: 0 },
    scorecard: {
      coordinators: [{ id: 5, title: 'Secret title', landed: true }, { id: 6, title: 'Other', landed: false }],
      workers: { total: 2, byCoordinator: { 5: [7] } },
      plans: { coordinatorsWithPlan: 1, epics: 1, tasks: 2 },
      landings: { count: 1, shas: ['abc'], pushed: [] },
      usage: { byModel: { m: { calls: 1, costUsd: 1 } }, totalCostUsd: 1, cacheHitRate: 0.9 },
      questions: { asked: 1, multi: 1, multiAnswered: 1, waitSec: [30], texts: ['Which colour, Daniel?'] },
      watchdog: { failures: 0, retries: 1 },
      toolErrors: 1,
      toolErrorDetail: { real: { bashExit: 1 }, benign: {}, list: [{ text: 'cat /home/someone/.env' }] },
      checks: [{ name: 'asked a card', pass: true, gate: 'finding', detail: 'message 3: Which colour?' }],
    },
  }
  const write = (id: string, r: object) => {
    mkdirSync(join(runs, id), { recursive: true })
    writeFileSync(join(runs, id, 'result.json'), JSON.stringify(r))
  }
  write('r1', raw)
  write('r2', { ...raw, id: 'r2', status: 'cancelled' })
  write('r3', { ...raw, id: 'r3', finishedAt: undefined })
  mkdirSync(join(runs, 'r4'))
  assert.equal(exportResults(runs, results), 1)
  assert.deepEqual(readdirSync(results), ['r1.json'])
  const text = readFileSync(join(results, 'r1.json'), 'utf8')
  assert.deepEqual(scan(text), [])
  for (const leak of ['Secret', 'colour', 'Daniel', 'blue', 'Add search', 'byCoordinator', 'shas', 'texts']) assert.ok(!text.includes(leak), leak)
  const out = JSON.parse(text)
  assert.deepEqual(out.failure, { reason: 'hang', atMin: 12, stuck: { busy: 1, open: 1, lastProgressMin: 10 } })
  assert.deepEqual(out.scorecard.coordinators, { started: 2, landed: 1 })
  assert.deepEqual(out.scorecard.questions.waitSec, [30])
  assert.deepEqual(out.acceptance, [{ name: 'opens a recipe', pass: true }])
  assert.match(table(readPublished(results)), /c0ffee  today  recipe-v2@aa  0\/1/)

  // The scan catches what an allowlisted field could still carry, and a refused export writes nothing.
  assert.deepEqual(scan('a@b.co'), ['@', 'email'])
  assert.deepEqual(scan('ops (at) example.org'), ['email'])
  assert.deepEqual(scan('host.tail1234.ts.net'), ['tail', '.ts.net'])
  assert.deepEqual(scan('/home/x http://localhost:1 127.0.0.1'), ['/home/', '127.0.0.1', 'localhost'])
  assert.deepEqual(scan('{"detail": true}'), [])
  const fresh = join(runs, 'refused')
  write('r1', { ...raw, acceptance: [{ name: 'mail ops@example.com', pass: true }] })
  assert.throws(() => exportResults(runs, fresh), /r1\.json: @, email/)
  assert.equal(existsSync(fresh), false)
})
