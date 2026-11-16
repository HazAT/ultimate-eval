/**
 * Rebuild a finished run's scorecard from what it stored (transcripts, the Messages log, the stopped home's sqlite),
 * so a new check or category reaches older runs. Checks on the project itself (`untouched`) need the deleted project:
 * an earlier result of one is kept. A run that now fails a `pass` gate is marked failed; a rescore never turns a
 * failed run into a pass.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Entry, Message, Summary } from './api.ts'
import { agentProfiles, automationsOf, ROOT } from './run.ts'
import { gateFailed, peerChecks, readExpect, score } from './score.ts'
import type { Scorecard } from './score.ts'

export async function rescore(dir: string) {
  const resultPath = join(dir, 'result.json')
  if (!existsSync(resultPath)) return undefined // still running
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  const transcripts = join(dir, 'transcripts')
  if (!result.scorecard || !existsSync(join(transcripts, 'conversations.json'))) return undefined
  const scenarioDir = join(ROOT, 'scenarios', result.pins.scenario)
  const { FEATURE_WORDS } = await import(join(scenarioDir, 'accept.ts'))
  const conversations = JSON.parse(readFileSync(join(transcripts, 'conversations.json'), 'utf8')) as Summary[]
  const histories: Record<number, Entry[]> = {}
  for (const name of readdirSync(transcripts))
    if (/^\d+\.json$/.test(name)) histories[Number(name.slice(0, -5))] = JSON.parse(readFileSync(join(transcripts, name), 'utf8'))
  const board = JSON.parse(readFileSync(join(transcripts, 'board.json'), 'utf8')) as { messages: Message[] }
  const said = JSON.parse(readFileSync(join(dir, 'sim.json'), 'utf8')).said as { at: number; who: string }[]
  const ultimate = conversations.find((c) => c.title === '@ultimate')?.id
  if (!ultimate) throw new Error(`${dir}: no @ultimate among the conversations`)
  const before = result.scorecard as Scorecard
  const card = score(
    {
      conversations,
      histories,
      board,
      ultimate,
      firstPromptAt: said.find((s) => s.who === 'you')?.at ?? 0,
      agents: agentProfiles(join(dir, 'home', 'state.sqlite')),
      automations: automationsOf(join(dir, 'home', 'state.sqlite')),
    },
    FEATURE_WORDS,
    readExpect(scenarioDir),
  )
  card.checks.push(...(before.checks ?? []).filter((c) => c.name === 'no unrelated files changed'))
  const peers = join(dir, 'peers')
  for (const name of existsSync(peers) ? readdirSync(peers).sort() : []) {
    const peerBoard = JSON.parse(readFileSync(join(peers, name, 'transcripts', 'board.json'), 'utf8')) as { messages: Message[] }
    const log = join(peers, name, 'home', 'supervisor.log')
    card.checks.push(...peerChecks(name, peerBoard, existsSync(log) ? readFileSync(log, 'utf8') : ''))
  }
  result.scorecard = card
  if (gateFailed(card)) result.pass = false
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  return result
}
