import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { shortAnswer, shortFirst, shortLast, startFake } from '../src/perf/fake.ts'

test('fake model sends paced OpenAI SSE chunks and records their timing', async () => {
  const fake = await startFake({
    chunkMs: 3,
    answer: (text) => {
      assert.equal(text, 'Measure this.')
      return shortAnswer
    },
  })
  try {
    const models = JSON.parse(await readFile(join(fake.agentDir, 'models.json'), 'utf8'))
    const provider = models.providers.fake
    assert.equal(provider.api, 'openai-completions')
    assert.deepEqual(provider.models, [{ id: 'fake-1' }])
    assert.deepEqual(JSON.parse(await readFile(join(fake.agentDir, 'settings.json'), 'utf8')), {
      defaultProvider: 'fake', defaultModel: 'fake-1',
    })
    const started = Date.now()
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Measure this.' }] }] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    const events = (await response.text()).trimEnd().split('\n\n').map((event) => {
      assert.match(event, /^data: [^\n]+$/)
      return event.slice(6)
    })
    assert.equal(events.pop(), '[DONE]')
    const chunks = events.map((event) => {
      const { id, object, model, choices } = JSON.parse(event)
      assert.equal(id, 'f')
      assert.equal(object, 'chat.completion.chunk')
      assert.equal(model, 'fake-1')
      assert.equal(choices.length, 1)
      assert.equal(choices[0].index, 0)
      return choices[0]
    })
    assert.deepEqual(chunks.pop(), { index: 0, delta: {}, finish_reason: 'stop' })
    assert.equal(chunks.length, 40)
    assert.equal(chunks[0].delta.role, 'assistant')
    assert.equal(chunks[0].delta.content, shortFirst)
    assert.equal(chunks.at(-1)?.delta.content, shortLast)
    assert.ok(chunks.every((c) => c.finish_reason === null && c.delta.content))
    assert.equal(chunks.map((c) => c.delta.content).join(''), shortAnswer.text)
    assert.equal(fake.requests.length, 1)
    const { arrivedAt, firstChunkAt, lastChunkAt, lastUserText, chunkSentAt } = fake.requests[0]!
    assert.equal(chunkSentAt.length, 40)
    assert.equal(chunkSentAt[0], firstChunkAt)
    assert.equal(chunkSentAt.at(-1), lastChunkAt)
    assert.equal(lastUserText, 'Measure this.')
    assert.ok(arrivedAt >= started)
    assert.ok(firstChunkAt !== undefined && firstChunkAt >= arrivedAt)
    assert.ok(lastChunkAt !== undefined && lastChunkAt - firstChunkAt >= 100 && lastChunkAt <= Date.now())
  } finally {
    await fake.close()
  }
})
