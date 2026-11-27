import { setTimeout } from 'node:timers/promises'
import { chromium, errors } from 'playwright-core'
import type { Page } from 'playwright-core'
import type { Entry } from '../api.ts'
import { longLine, shortFirst, shortLast } from './fake.ts'
import type { perfInstance } from './instance.ts'
import { installProbe, keypressStats, liveRowVisible, percentile, targetRowVisible } from './metrics.ts'
import { longPrompt } from './seed.ts'
import type { seed } from './seed.ts'

type Metric<T> = T | { error: string }
type Load = { dclMs: number; fcpMs: number; transcriptMs: number; coverMs: number | null; transferBytes: number }
type Switch = { id: number; round: number; freshViewMs: number | null; visibleMs: number; settledMs: number; longMs: number }
type Distribution = { count: number; totalMs: number; p95Ms: number | null }
type Frames = { longtask: Distribution; longAnimationFrame: Omit<Distribution, 'p95Ms'> | null; rafGapsOver33Ms: number }
type Progress = {
  markers: { line: number; sentMs: number; visibleMs: number | null; lagMs: number | null }[]
  visibleCount: number; firstProgressMs: number; maxGapMs: number | null; p95GapMs: number | null; p95LagMs: number | null
}

export type Sample = {
  firstBuildMs: Metric<number>
  firstLoad: { cold: Metric<Load>; warm: Metric<Load> }
  sendToResponse: Metric<{ userMs: number; answerMs: number }>
  ttft: Metric<{ serverPrepMs: number; streamToVisibleMs: number; totalMs: number; lastChunkMs: number; lastChunkToVisibleMs: number }>
  switch: Metric<{ cold: Switch[]; warm: Switch[] }>
  streaming: Metric<{ progress: Progress; frames: Frames; instrumentedFrames: Frames }>
  memory: Metric<{ jsHeapUsedMB: number; nodes: number; jsEventListeners: number }>
  reconnect: Metric<{ startedAt: number; readyAt: number; viewAt: number; handshakeMs: number | null; readyToViewMs: number; outageMs: number; restartBuildMs: Metric<number> }>
  keypress: Metric<ReturnType<typeof keypressStats> & { eventTimingCount: number }>
}

const shortPrompt = 'Benchmark this short reply.'
const markerLines = Array.from({ length: 16 }, (_, i) => (i + 1) * 100)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const probeScript = { content: `(${installProbe.toString()})(${liveRowVisible.toString()}, ${targetRowVisible.toString()})` }

// Oct 26's root is the read-only History screen. Navigate to seeded conversations and use the cross-era textarea,
// rather than composer data-ui hooks which arrived in November. The reload cover can clone that textarea too.
const composer = (page: Page) => page.locator('#app textarea:visible').last()

/** Measure a seed that the caller has snapshotted, restoring it before opening Chromium. */
export async function measure(instance: Awaited<ReturnType<typeof perfInstance>>, data: Pick<Awaited<ReturnType<typeof seed>>, 'sidebarIds' | 'transcriptIds'>, {
  log = () => {}, signal,
}: { log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<Sample> {
  const [a, b] = data.transcriptIds
  const [sidebar, start] = data.sidebarIds
  if (a === undefined || b === undefined || sidebar === undefined || start === undefined) {
    throw new Error('measure requires two seeded transcripts and at least two sidebar conversations')
  }
  const url = (id: number) => `${instance.base}/?conversation=${id}`
  const check = () => signal?.throwIfAborted()
  async function record<T>(name: string, fn: () => Promise<T>): Promise<Metric<T>> {
    check()
    log(`measure: ${name}`)
    try {
      return await fn()
    } catch (error) {
      check()
      const message = error instanceof Error ? error.message : String(error)
      log(`measure: ${name}: ${message}`)
      return { error: message }
    }
  }
  check()
  await instance.restore()
  check()
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium', env: instance.env, headless: true, args: ['--enable-precise-memory-info'],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  })
  const cancel = () => { void browser.close().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const pace = instance.fake.chunkMs
  try {
    check()
    const options = { viewport: { width: 1440, height: 900 } }
    async function build() {
      const context = await browser.newContext(options)
      try {
        await context.addInitScript(probeScript)
        const page = await context.newPage()
        const started = performance.now()
        const response = await page.goto(url(a), { waitUntil: 'load', timeout: 120_000 })
        if (!response?.ok()) throw new Error(`warm-up navigation failed (${response?.status()})`)
        return performance.now() - started
      } finally {
        await context.close()
      }
    }
    const firstBuildMs = await record('firstBuildMs', build)
    const context = await browser.newContext(options)
    await context.addInitScript(probeScript)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const cdp = await context.newCDPSession(page)
    const navigate = async (id: number) => {
      const response = await page.goto(url(id), { waitUntil: 'commit' })
      if (!response?.ok()) throw new Error(`navigation to #${id} failed (${response?.status()})`)
    }
    async function lastReply(id: number) {
      const response = await fetch(`${instance.base}/api/conversations/${id}/history?before=${Number.MAX_SAFE_INTEGER}`, {
        headers: { origin: instance.base }, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      })
      if (!response.ok) throw new Error(`transcript history returned ${response.status}`)
      const { entries } = await response.json() as { entries: Entry[] }
      const last = entries.find((entry) => entry.model?.some((message) => message.role === 'assistant' && message.stopReason === 'stop'))
      if (!last) throw new Error(`no completed seed reply in transcript #${id}`)
      return last.id
    }
    async function waitForTarget() {
      try {
        const ready = await page.waitForFunction(() => window.perfProbe?.target)
        const result = await ready.jsonValue()
        if (!result) throw new Error('target timing missing')
        return result
      } finally {
        await page.evaluate(() => window.perfProbe?.stopTarget()).catch(() => {})
      }
    }
    async function target(entry: number | null, quietMs = 0) {
      await page.evaluate(({ entry, quietMs }) => window.perfProbe.startTarget(entry, quietMs), { entry, quietMs })
      return waitForTarget()
    }
    let loadEntry: number | undefined
    async function load(): Promise<Load> {
      loadEntry ??= await lastReply(a!)
      await navigate(a!)
      const { visible: transcriptMs } = await target(loadEntry)
      const loaded = await page.waitForFunction(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]
        return navigation?.loadEventEnd && fcp && {
          dclMs: navigation.domContentLoadedEventEnd,
          fcpMs: fcp.startTime,
          coverMs: window.perfProbe.coverMs,
          transferBytes: navigation.transferSize + (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .reduce((total, entry) => total + entry.transferSize, 0),
        }
      })
      const result = await loaded.jsonValue()
      if (!result) throw new Error('load timing missing')
      return { ...result, transcriptMs }
    }
    const cold = await record('firstLoad.cold', async () => {
      await cdp.send('Network.clearBrowserCache')
      return load()
    })
    const warm = await record('firstLoad.warm', load)
    const switches = await record('switch', measureSwitches)

    async function send(user: string, markers?: string[]) {
      await composer(page).focus()
      await page.keyboard.type(user)
      if (markers) await page.evaluate(({ user, markers }) => window.perfProbe.watchText(user, markers), { user, markers })
      const offset = instance.fake.requests.length
      await page.keyboard.press('Enter')
      return offset
    }
    async function request(offset: number, text: string, chunks = 1, timeoutMs = 15_000) {
      const started = performance.now()
      for (;;) {
        check()
        const found = instance.fake.requests.slice(offset).find((item) => item.lastUserText === text && item.chunkSentAt.length >= chunks)
        if (found) return found as typeof found & { firstChunkAt: number }
        if (performance.now() - started > timeoutMs) throw new Error(`fake did not send ${chunks} chunk(s) for ${JSON.stringify(text)}`)
        await setTimeout(20, undefined, { signal })
      }
    }
    let short: { key: number; first: number; last: number; offset: number } | undefined
    const sendToResponse = await record('sendToResponse', async () => {
      await navigate(b)
      await target(await lastReply(b))
      instance.fake.chunkMs = 25
      try {
        const offset = await send(shortPrompt, [shortFirst, shortLast])
        const timing = await page.waitForFunction(() => {
          const watch = window.perfProbe.watch!
          const [first, last] = watch.marks
          return watch.key !== undefined && watch.echoed !== undefined && first != null && last != null && {
            key: watch.key, echoed: watch.echoed, first, last, origin: performance.timeOrigin,
          }
        })
        const times = await timing.jsonValue()
        if (!times) throw new Error('short response timing missing')
        short = { key: times.origin + times.key, first: times.origin + times.first, last: times.origin + times.last, offset }
        return { userMs: times.echoed - times.key, answerMs: times.first - times.key }
      } finally {
        instance.fake.chunkMs = pace
        await page.evaluate(() => window.perfProbe.stopText()).catch(() => {})
      }
    })
    const ttft = await record('ttft', async () => {
      if (!short) throw new Error('short send did not reach the live transcript')
      const timing = await request(short.offset, shortPrompt)
      if (!timing.lastChunkAt || timing.chunkSentAt.length !== 40) throw new Error('fake did not finish the 40-chunk reply')
      // The rAF checks show when the first and last chunks are visible at a rendering opportunity, not when pixels paint.
      return {
        serverPrepMs: timing.arrivedAt - short.key, streamToVisibleMs: short.first - timing.firstChunkAt, totalMs: short.first - short.key,
        lastChunkMs: short.last - short.key, lastChunkToVisibleMs: short.last - timing.lastChunkAt,
      }
    })

    async function measureSwitches() {
      // Switch before any sends, so every large target ends at its last seeded reply. Start from a fresh tab store.
      const entries = new Map([[a, await lastReply(a)], [b, await lastReply(b)], [sidebar, null]])
      await navigate(start)
      await target(null)
      const cold: Switch[] = [], warm: Switch[] = []
      for (let round = 0; round < 3; round++) {
        for (const id of [a, sidebar, b]) {
          check()
          const began = await page.evaluate(({ id, entry }) => {
            window.perfProbe.startTarget(entry, 300)
            const now = performance.now()
            history.pushState(null, '', `/?conversation=${id}`)
            dispatchEvent(new PopStateEvent('popstate'))
            return now
          }, { id, entry: entries.get(id)! })
          const { visible, settled } = await waitForTarget()
          // Read the first fresh SSE view separately; it cannot reset the display or quiet timers.
          const fresh = await page.waitForFunction(({ id, began }) => window.perfProbe.events.find((event) =>
            event.conversation === id && event.t >= began), { id, began }).catch((error: unknown) => {
            if (!(error instanceof errors.TimeoutError)) throw error
            return null
          })
          const view = await fresh?.jsonValue()
          const durations = await page.evaluate(({ began, settled }) => window.perfProbe.timings
            .filter((entry) => entry.type === 'longtask' && entry.t >= began && entry.t <= settled).map((entry) => entry.duration), { began, settled })
          ;(round === 0 ? cold : warm).push({ id, round, freshViewMs: view ? view.t - began : null, visibleMs: visible - began,
            settledMs: settled - began, longMs: sum(durations) })
        }
      }
      return { cold, warm }
    }

    async function stream(markers?: string[]) {
      await page.evaluate(() => {
        const frames: number[] = []
        window.perfProbe.frames = frames
        const frame = (timestamp: number) => {
          if (window.perfProbe.frames !== frames) return
          frames.push(timestamp)
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      try {
        const offset = await send(longPrompt, markers)
        const timing = await request(offset, longPrompt, markers ? 1 : 1600, markers ? 15_000 : 90_000)
        if (markers) await page.waitForFunction(() => window.perfProbe.watch?.marks.at(-1) != null, undefined, { timeout: 90_000 })
        if (timing.chunkSentAt.length !== 1600 || !timing.lastChunkAt || timing.lastChunkAt - timing.firstChunkAt < 39_000)
          throw new Error('fake did not deliver the paced 1,600-chunk reply')
        // The control pass never reads the transcript. Allow a fixed tail for the client to apply the last chunk.
        const controlEnd = markers ? null : timing.lastChunkAt + 1000
        if (controlEnd !== null) await setTimeout(Math.max(0, controlEnd - Date.now()), undefined, { signal })
        const metrics = await page.evaluate(({ firstChunk, controlEnd }) => {
          const probe = window.perfProbe
          const start = firstChunk - performance.timeOrigin
          const end = controlEnd === null ? probe.watch!.marks.at(-1)! : controlEnd - performance.timeOrigin
          const windowed = probe.timings.filter((entry) => entry.t >= start && entry.t <= end)
          return {
            visible: probe.watch?.marks.map((t) => t === null ? null : t - start),
            tasks: windowed.filter((entry) => entry.type === 'longtask').map((entry) => entry.duration),
            frames: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
              ? windowed.filter((entry) => entry.type === 'long-animation-frame').map((entry) => entry.duration) : null,
            gaps: probe.frames!.filter((t, i, frames) => i > 0 && t >= start && t <= end && t - frames[i - 1]! > 33).length,
          }
        }, { firstChunk: timing.firstChunkAt, controlEnd })
        return { timing, visible: metrics.visible, frames: {
          longtask: { count: metrics.tasks.length, totalMs: sum(metrics.tasks), p95Ms: percentile(metrics.tasks, 0.95) },
          longAnimationFrame: metrics.frames && { count: metrics.frames.length, totalMs: sum(metrics.frames) },
          rafGapsOver33Ms: metrics.gaps,
        } }
      } finally {
        await page.evaluate(() => { delete window.perfProbe.frames; window.perfProbe.stopText() }).catch(() => {})
      }
    }
    const streaming = await record('streaming', async () => {
      if (page.url() !== url(b)) await navigate(b)
      await target(await lastReply(b))
      instance.fake.chunkMs = 25
      try {
        // Run the control first in the same pre-long-reply transcript state in every era.
        // The marker pass starts with the control's 1,600-line reply already in the transcript.
        const { frames } = await stream()
        const { timing, visible: marks, frames: instrumentedFrames } = await stream(markerLines.map(longLine))
        const markers = markerLines.map((line, i) => {
          const sentMs = timing.chunkSentAt[line - 1]! - timing.firstChunkAt
          const visibleMs = marks![i]!
          return { line, sentMs, visibleMs, lagMs: visibleMs === null ? null : visibleMs - sentMs }
        })
        const visible = markers.flatMap((mark) => mark.visibleMs ?? []).sort((a, b) => a - b)
        const gaps = visible.slice(1).map((t, i) => t - visible[i]!)
        return {
          // Track the first progress separately: a renderer showing only the last marker has no inter-marker gaps.
          progress: { markers, visibleCount: visible.length, firstProgressMs: visible[0]!, maxGapMs: gaps.length ? Math.max(...gaps) : null,
            p95GapMs: percentile(gaps, 0.95), p95LagMs: percentile(markers.flatMap((mark) => mark.lagMs ?? []), 0.95) },
          frames, instrumentedFrames,
        }
      } finally {
        instance.fake.chunkMs = pace
      }
    })
    const memory = await record('memory', async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('Performance.enable')
      const { metrics } = await cdp.send('Performance.getMetrics')
      const value = (name: string) => {
        const metric = metrics.find((entry) => entry.name === name)
        if (!metric) throw new Error(`CDP did not return ${name}`)
        return metric.value
      }
      return { jsHeapUsedMB: value('JSHeapUsedSize') / 1048576, nodes: value('Nodes'), jsEventListeners: value('JSEventListeners') }
    })
    const keypress = await record('keypress', async () => {
      // Use the unchanged seed on a quiet transcript, not a partially rebuilt page after restart.
      await navigate(a)
      await target(await lastReply(a), 300)
      const keys = 'abcdefghijklmnopqrstuvwxyz1234'
      await composer(page).focus()
      const from = await composer(page).evaluate((element, keys) => {
        window.perfProbe.watchKeys(element as HTMLTextAreaElement, keys)
        return performance.now()
      }, keys)
      await page.keyboard.type(keys, { delay: 50 })
      const until = await page.evaluate(() => performance.now())
      const painted = await page.waitForFunction((n) => {
        const observed = window.perfProbe.keys
        return observed?.length === n && observed.every((ms) => ms !== null) && observed
      }, keys.length)
      const values = await painted.jsonValue()
      if (!values) throw new Error('keypress paint timing missing')
      const eventTimingCount = await page.evaluate(({ from, until }) => window.perfProbe.timings.filter((entry) =>
        entry.type === 'event' && entry.t >= from && entry.t <= until && ['keydown', 'keypress', 'input'].includes(entry.name)).length, { from, until })
      return { ...keypressStats(values, keys.length), eventTimingCount }
    })
    const reconnect = await record('reconnect', async () => {
      if (page.url() !== url(a)) await navigate(a)
      await target(await lastReply(a))
      const startedAt = Date.now()
      await instance.restart()
      const readyAt = Date.now()
      const arrived = await page.waitForFunction(({ startedAt, id }) => {
        // The comparable endpoint is a fresh view of the shown conversation on a new connection:
        // Oct 26 has loose list/view streams and no `stream` handshake; neither a handshake nor a list update proves the transcript is live.
        const since = startedAt - performance.timeOrigin
        const events = window.perfProbe.events
        const view = events.find((event) => event.conversation === id && event.t >= since && events.some((open) =>
          open.name === 'open' && open.connection === event.connection && open.t >= since && new URL(open.url).pathname === '/api/events'))
        if (!view) return false
        const handshake = events.find((event) => event.name === 'stream' && event.connection === view.connection && event.t >= since)
        return { viewAt: performance.timeOrigin + view.t, handshakeMs: handshake ? handshake.t - since : null }
      }, { startedAt, id: a }, { timeout: 30_000 })
      const timing = await arrived.jsonValue()
      if (!timing) throw new Error('target view on a new event stream missing')
      // SSE may arrive before the periodic API readiness poll notices the server.
      const { viewAt } = timing
      const restartBuildMs = await record('reconnect.restartBuildMs', build)
      return { startedAt, readyAt, ...timing, readyToViewMs: viewAt - readyAt, outageMs: viewAt - startedAt, restartBuildMs }
    })
    return { firstBuildMs, firstLoad: { cold, warm }, sendToResponse, ttft, switch: switches, streaming, memory, reconnect, keypress }
  } finally {
    instance.fake.chunkMs = pace
    signal?.removeEventListener('abort', cancel)
    await browser.close()
  }
}
