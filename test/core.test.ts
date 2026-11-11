import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, openQuestions } from '../src/api.ts'
import type { Entry, Message } from '../src/api.ts'
import { shapeAnswers } from '../src/sim.ts'
import { score } from '../src/score.ts'
import { median, table } from '../src/report.ts'
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
    { asked: card.questions.asked, multi: card.questions.multi, wait: card.questions.waitSec },
    { asked: 1, multi: 1, wait: [30] },
  )
  assert.equal(card.watchdog.failures, 1)
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
    'mismatch',
  )
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
    scorecard: { usage: { totalCostUsd: cost }, coordinators: [], workers: { total: 0 } },
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
})
