/** A local OpenAI chat-completions provider, with no real credentials or model calls. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export type Answer = { text: string; chunks: number | string[]; tool?: { name: string; args: unknown } }
export type FakeOptions = { chunkMs: number; answer: (lastUserText: string) => Answer }
export type RequestTiming = { arrivedAt: number; lastUserText: string; firstChunkAt?: number; lastChunkAt?: number; chunkSentAt: number[] }

const split = (text: string, chunks: number) => {
  const points = Array.from(text)
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > points.length) throw new Error('invalid fake chunk count')
  return Array.from({ length: chunks }, (_, i) =>
    points.slice(Math.floor(i * points.length / chunks), Math.floor((i + 1) * points.length / chunks)).join(''))
}
const answerFrom = (chunks: string[]) => ({ text: chunks.join(''), chunks })
export const shortFirst = 'StartPulse'
export const shortLast = 'EndPulse'
export const shortAnswer = answerFrom([shortFirst, ...split(' The reply arrived from the local scripted model. ', 38), shortLast])
export const longLine = (i: number) => `This is benchmark line ${i}.`
// One chunk per line, so a displayed marker can be compared with the send time of that exact line.
export const longAnswer = (chunks = 1600): Answer => answerFrom(Array.from({ length: chunks }, (_, i) => `${longLine(i + 1)}\n`))

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'f', object: 'chat.completion.chunk', created: 0, model: 'fake-1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

export async function startFake({ chunkMs, answer }: FakeOptions) {
  const agentDir = await mkdtemp(join(tmpdir(), 'ue-perf-agent-'))
  const requests: RequestTiming[] = []
  const fake = { agentDir, requests, chunkMs, close }
  const server = createServer((request, response) => {
    void stream(request, response).catch((error: unknown) => {
      if (response.destroyed) return
      if (response.headersSent) response.destroy()
      else response.writeHead(400).end(String(error))
    })
  })

  async function stream(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const timing: RequestTiming = { arrivedAt: Date.now(), lastUserText: '', chunkSentAt: [] }
    requests.push(timing)
    const pace = fake.chunkMs
    let body = ''
    request.setEncoding('utf8')
    for await (const data of request) body += data
    const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
    const last = messages.at(-1)
    timing.lastUserText = textOf(messages.findLast((message) => message.role === 'user')?.content)
    const { text, chunks, tool } = answer(timing.lastUserText)
    const call = last?.role === 'user' ? tool : undefined
    const disconnected = new AbortController()
    response.once('close', () => disconnected.abort())
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta: object) => {
      response.write(chunk(delta))
      timing.lastChunkAt = Date.now()
      timing.firstChunkAt ??= timing.lastChunkAt
      timing.chunkSentAt.push(timing.lastChunkAt)
    }
    if (call) {
      send({ role: 'assistant', tool_calls: [{
        index: 0, id: 'call_seed', type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }] })
    } else {
      const parts = typeof chunks === 'number' ? split(text, chunks) : chunks
      const started = performance.now()
      for (const [i, content] of parts.entries()) {
        const delay = started + i * pace - performance.now()
        if (delay > 0) await setTimeout(delay, undefined, { signal: disconnected.signal })
        if (response.destroyed) return
        send(i === 0 ? { role: 'assistant', content } : { content })
      }
    }
    response.write(chunk({}, call ? 'tool_calls' : 'stop'))
    response.end('data: [DONE]\n\n')
  }

  async function close() {
    const closed = new Promise<void>((done) => server.close(() => done()))
    server.closeAllConnections()
    await closed
    await rm(agentDir, { recursive: true, force: true })
  }

  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
      providers: { fake: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'fake-1' }],
      } },
    }))
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-1' }))
    return fake
  } catch (error) {
    await close()
    throw error
  }
}
