/** Deterministic transcript contents and sizes, created through the same HTTP API the web UI uses. */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Instance } from '../api.ts'
import type { Entry } from '../api.ts'
import { answerText } from '../score.ts'
import { shortAnswer } from './fake.ts'
import type { Answer } from './fake.ts'

export function seedAnswer(lastUserText: string): Answer {
  const turn = /^Performance seed: transcript ([12]), turn (\d+)\.$/.exec(lastUserText)
  if (!turn) return shortAnswer
  const label = `${turn[1]}.${turn[2]}`
  const text = `## Seed turn ${label}\n\n` + Array.from({ length: 5 }, (_, i) => [
    `### Step ${i + 1}: inspect the fixture`,
    '',
    'The fixture is unchanged. This paragraph represents the explanation that accompanies a small code sample in a typical coding conversation.',
    '',
    '```ts',
    `const step = { turn: '${label}', number: ${i + 1} }`,
    'console.log(step)',
    '```',
    '',
  ].join('\n')).join('\n')
  return {
    text, chunks: 40,
    ...(Number(turn[2]) % 5 === 0 ? { tool: { name: 'read', args: { path: 'fixture.txt' } } } : {}),
  }
}

/** Wait for the conversation to be idle and for this specific reply to be persisted. */
export async function prompt(api: Instance, id: number, text: string, expected: string, signal?: AbortSignal) {
  const before = Number.MAX_SAFE_INTEGER
  const history = `/api/conversations/${id}/history?before=${before}`
  const newest = (await api.get<{ entries: Entry[] }>(history)).entries[0]?.id ?? 0
  await api.submit(id, text)
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    signal?.throwIfAborted()
    if (api.downSince === undefined && api.conversations.find((c) => c.id === id)?.busy === false) {
      const { entries } = await api.get<{ entries: Entry[] }>(history)
      const reply = entries.find((entry) => entry.id > newest && entry.model?.[0]?.role === 'assistant' &&
        entry.model[0].stopReason === 'stop' && answerText(entry).trimEnd() === expected.trimEnd())
      if (reply) return
    }
    await api.changed(100)
  }
  throw new Error(`no completed fake reply in conversation #${id} for ${JSON.stringify(text)}`)
}

export async function seed(instance: { base: string; home: string; fake: { chunkMs: number } }, options: {
  sidebar?: number
  turns?: number
  signal?: AbortSignal
  log?: (line: string) => void
} = {}) {
  const { sidebar = 300, turns = 300, signal, log = console.log } = options
  const api = new Instance(instance.base)
  const cancel = () => api.close()
  signal?.addEventListener('abort', cancel, { once: true })
  const started = performance.now()
  const pace = instance.fake.chunkMs
  instance.fake.chunkMs = 0
  try {
    signal?.throwIfAborted()
    await api.open()
    const create = async (title: string) => (await api.post<{ id: number }>('/api/conversations', { title })).id
    const sidebarIds: number[] = []
    const transcriptIds: number[] = []
    const titles = new Map<number, string>()
    for (let i = 1; i <= sidebar; i++) {
      const title = `Performance sidebar ${String(i).padStart(3, '0')}`
      const id = await create(title)
      sidebarIds.push(id)
      titles.set(id, title)
    }
    // Titled ownerless drafts are rows in the sidebar on all five eras; no exchange is needed to list them.
    const deadline = performance.now() + 30_000
    while ([...titles].some(([id, title]) => !api.conversations.some((c) => c.id === id && c.title === title))) {
      signal?.throwIfAborted()
      if (performance.now() > deadline) throw new Error('titled sidebar conversations did not appear in the conversation list')
      await api.changed(100)
    }
    for (let i = 1; i <= 2; i++) {
      const id = await create(`Performance transcript ${i}`)
      transcriptIds.push(id)
      for (let j = 1; j <= turns; j++) {
        const text = `Performance seed: transcript ${i}, turn ${j}.`
        await prompt(api, id, text, seedAnswer(text).text, signal)
      }
    }
    const entryCounts: number[] = []
    const toolCounts: number[] = []
    for (const id of transcriptIds) {
      const entries = await api.history(id)
      entryCounts.push(entries.length)
      toolCounts.push(entries.filter((entry) => entry.model?.[0]?.role === 'toolResult').length)
    }
    const result = { sidebarIds, transcriptIds, entryCounts, toolCounts, seconds: (performance.now() - started) / 1000 }
    writeFileSync(join(dirname(instance.home), 'seed.json'), JSON.stringify(result, null, 2) + '\n')
    log(`seed: ${result.seconds.toFixed(1)} s, ${sidebarIds.length + transcriptIds.length} conversations, ` +
      `transcript entries ${entryCounts.join(' + ')}, tool results ${toolCounts.join(' + ')}`)
    return result
  } finally {
    instance.fake.chunkMs = pace
    api.close()
    signal?.removeEventListener('abort', cancel)
  }
}
