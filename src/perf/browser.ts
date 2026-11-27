import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import type { Entry } from '../api.ts'
import { shortAnswer } from './fake.ts'
import type { perfInstance } from './instance.ts'
import { installProbe, median, percentile } from './metrics.ts'
import { longPrompt } from './seed.ts'
import type { seed } from './seed.ts'

type Metric<T> = T | { error: string }
type Load = { dclMs: number; fcpMs: number; transcriptMs: number; transferBytes: number }
type Switch = { id: number; round: number; settledMs: number; longMs: number }
type Distribution = { count: number; totalMs: number; p95Ms: number | null }

export type Sample = {
  firstBuildMs: Metric<number>
  firstLoad: { cold: Metric<Load>; warm: Metric<Load> }
  sendToResponse: Metric<{ userMs: number; answerMs: number }>
  ttft: Metric<{ serverPrepMs: number; streamToPaintMs: number; totalMs: number }>
  switch: Metric<{ cold: Switch[]; warm: Switch[] }>
  streaming: Metric<{ longtask: Distribution; longAnimationFrame: Omit<Distribution, 'p95Ms'> | null; rafGapsOver33Ms: number }>
  memory: Metric<{ jsHeapUsedMB: number; nodes: number; jsEventListeners: number }>
  reconnect: Metric<{ startedAt: number; readyAt: number; firstEventAt: number; readyToEventMs: number; outageMs: number; restartBuildMs: Metric<number> }>
  keypress: Metric<{ count: number; duration: { medianMs: number; p95Ms: number }; inputDelay: { medianMs: number; p95Ms: number } }>
}

const shortPrompt = 'Benchmark this short reply.'
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// Oct 26's root is the read-only History screen. Navigate to seeded conversations and use the cross-era textarea,
// rather than composer/transcript data-ui hooks which arrived in November.
const composer = (page: Page) => page.locator('textarea:visible').last()

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
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--enable-precise-memory-info'] })
  const cancel = () => { void browser.close().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const pace = instance.fake.chunkMs
  try {
    check()
    const options = { viewport: { width: 1440, height: 900 } }
    async function build() {
      const context = await browser.newContext(options)
      try {
        await context.addInitScript(installProbe)
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
    await context.addInitScript(installProbe)
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
    let loadEntry: number | undefined
    async function load(): Promise<Load> {
      loadEntry ??= await lastReply(a!)
      await navigate(a!)
      const ready = await page.waitForFunction((id) => {
        const entries = document.querySelectorAll(`[data-entry-id="${id}"]`)
        for (const entry of entries) {
          const rect = entry.getBoundingClientRect()
          if (!entry.checkVisibility({ visibilityProperty: true }) || !rect.width || !rect.height) continue
          const scroll = entry.closest('[data-ui="transcript"]') ?? entry.parentElement
          const bounds = scroll?.getBoundingClientRect()
          if (rect.bottom > Math.max(0, bounds?.top ?? 0) && rect.top < Math.min(innerHeight, bounds?.bottom ?? innerHeight)) {
            return performance.now()
          }
        }
        return false
      }, loadEntry)
      const transcriptMs = await ready.jsonValue()
      const loaded = await page.waitForFunction(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]
        return navigation?.loadEventEnd && fcp && {
          dclMs: navigation.domContentLoadedEventEnd,
          fcpMs: fcp.startTime,
          transferBytes: navigation.transferSize + (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .reduce((total, entry) => total + entry.transferSize, 0),
        }
      })
      const result = await loaded.jsonValue()
      if (!result || !transcriptMs) throw new Error('load timing missing')
      return { ...result, transcriptMs }
    }
    const cold = await record('firstLoad.cold', async () => {
      await cdp.send('Network.clearBrowserCache')
      return load()
    })
    const warm = await record('firstLoad.warm', load)

    async function arm(user: string, end: string, prefix?: string) {
      await composer(page).focus()
      await page.keyboard.type(user)
      await page.evaluate((watch) => { window.perfProbe.watch = watch }, { user, prefix, end })
      const offset = instance.fake.requests.length
      await page.keyboard.press('Enter')
      return offset
    }
    async function request(offset: number, text: string) {
      const started = performance.now()
      for (;;) {
        check()
        const found = instance.fake.requests.slice(offset).find((item) => item.lastUserText === text && item.firstChunkAt !== undefined)
        if (found) return { ...found, firstChunkAt: found.firstChunkAt! }
        if (performance.now() - started > 15_000) throw new Error(`fake did not stream a reply for ${JSON.stringify(text)}`)
        await setTimeout(20, undefined, { signal })
      }
    }
    let short: { key: number; first: number; offset: number } | undefined
    const sendToResponse = await record('sendToResponse', async () => {
      const last = await lastReply(b)
      await navigate(b)
      await waitForView(page, b)
      await page.locator(`[data-entry-id="${last}"]:visible`).last().waitFor()
      const offset = await arm(shortPrompt, shortAnswer.text, 'Performance check')
      const timing = await page.waitForFunction(() => {
        const watch = window.perfProbe.watch!
        return watch.key !== undefined && watch.echoed !== undefined && watch.first !== undefined && watch.done !== undefined && {
          key: watch.key, echoed: watch.echoed, first: watch.first, origin: performance.timeOrigin,
        }
      })
      const times = await timing.jsonValue()
      if (!times) throw new Error('short response timing missing')
      short = { key: times.origin + times.key, first: times.origin + times.first, offset }
      return { userMs: times.echoed - times.key, answerMs: times.first - times.key }
    })
    const ttft = await record('ttft', async () => {
      if (!short) throw new Error('short send did not reach the DOM')
      const timing = await request(short.offset, shortPrompt)
      return { serverPrepMs: timing.arrivedAt - short.key, streamToPaintMs: short.first - timing.firstChunkAt, totalMs: short.first - short.key }
    })

    const switches = await record('switch', async () => {
      // Start from another sidebar row in a fresh document: none of the three targets has been shown in this tab's store.
      await navigate(start)
      await waitForView(page, start)
      const cold: Switch[] = [], warm: Switch[] = []
      for (let round = 0; round < 3; round++) {
        for (const id of [a, sidebar, b]) {
          check()
          const began = await page.evaluate((id) => {
            const now = performance.now()
            history.pushState(null, '', `/?conversation=${id}`)
            dispatchEvent(new PopStateEvent('popstate'))
            return now
          }, id)
          const settled = await page.waitForFunction(({ id, began }) => {
            const probe = window.perfProbe
            const view = probe.events.find((event) => event.conversation === id && event.t >= began)
            if (!view || probe.lastMutation < began || performance.now() - Math.max(view.t, probe.lastMutation) < 300) return false
            return probe.lastMutation
          }, { id, began })
          const end = await settled.jsonValue()
          if (!end) throw new Error(`switch to #${id} did not settle`)
          const durations = await page.evaluate(({ began, end }) => window.perfProbe.timings
            .filter((entry) => entry.type === 'longtask' && entry.t >= began && entry.t <= end).map((entry) => entry.duration), { began, end })
          ;(round === 0 ? cold : warm).push({ id, round, settledMs: end - began, longMs: sum(durations) })
        }
      }
      return { cold, warm }
    })

    async function ensureTranscript() {
      if (page.url() !== url(b)) await navigate(b)
      await waitForView(page, b)
    }
    const streaming = await record('streaming', async () => {
      await ensureTranscript()
      instance.fake.chunkMs = 25
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
        const offset = await arm(longPrompt, 'This is benchmark line 1600.')
        const timing = await request(offset, longPrompt)
        await page.waitForFunction(() => window.perfProbe.watch?.done !== undefined, undefined, { timeout: 90_000 })
        const lastChunk = instance.fake.requests.slice(offset).find((item) => item.lastUserText === longPrompt)?.lastChunkAt
        if (lastChunk === undefined || lastChunk - timing.firstChunkAt < 39_000) throw new Error('fake did not deliver the paced 1,600-chunk reply')
        const metrics = await page.evaluate((firstChunk) => {
          const probe = window.perfProbe
          const start = firstChunk - performance.timeOrigin
          const end = probe.watch!.done!
          const windowed = probe.timings.filter((entry) => entry.t >= start && entry.t <= end)
          return {
            tasks: windowed.filter((entry) => entry.type === 'longtask').map((entry) => entry.duration),
            frames: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
              ? windowed.filter((entry) => entry.type === 'long-animation-frame').map((entry) => entry.duration) : null,
            gaps: probe.frames!.filter((t, i, frames) => i > 0 && t >= start && t <= end && t - frames[i - 1]! > 33).length,
          }
        }, timing.firstChunkAt)
        return {
          longtask: { count: metrics.tasks.length, totalMs: sum(metrics.tasks), p95Ms: percentile(metrics.tasks, 0.95) },
          longAnimationFrame: metrics.frames && { count: metrics.frames.length, totalMs: sum(metrics.frames) },
          rafGapsOver33Ms: metrics.gaps,
        }
      } finally {
        instance.fake.chunkMs = pace
        await page.evaluate(() => { delete window.perfProbe.frames }).catch(() => {})
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
    const reconnect = await record('reconnect', async () => {
      await ensureTranscript()
      const startedAt = Date.now()
      await instance.restart()
      // Readiness is polled by the instance; SSE may arrive between polls, so keep the signed difference.
      const readyAt = Date.now()
      const arrived = await page.waitForFunction((startedAt) => {
        // Compare opens in epoch time: a reload during restart would reset both the clock and source IDs.
        const since = startedAt - performance.timeOrigin
        const opened = new Set<number>()
        for (const event of window.perfProbe?.events ?? []) {
          if (event.t < since) continue
          if (event.name === 'open' && new URL(event.url).pathname === '/api/events') opened.add(event.connection)
          else if (!['construct', 'error'].includes(event.name) && opened.has(event.connection)) return performance.timeOrigin + event.t
        }
        return false
      }, startedAt, { timeout: 30_000 })
      const firstEventAt = await arrived.jsonValue()
      if (typeof firstEventAt !== 'number') throw new Error('first event on new stream missing')
      log(`measure: reconnect readyAt=${readyAt}, firstEventAt=${firstEventAt}`)
      const restartBuildMs = await record('reconnect.restartBuildMs', build)
      return { startedAt, readyAt, firstEventAt, readyToEventMs: firstEventAt - readyAt, outageMs: firstEventAt - startedAt, restartBuildMs }
    })
    const keypress = await record('keypress', async () => {
      await ensureTranscript()
      await composer(page).focus()
      const from = await page.evaluate(() => performance.now())
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyz1234', { delay: 50 })
      const until = await page.evaluate(() => performance.now())
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const entries = await page.evaluate(({ from, until }) => window.perfProbe.timings.filter((entry) =>
        entry.type === 'event' && entry.t >= from && entry.t <= until && ['keydown', 'keypress', 'input'].includes(entry.name)), { from, until })
      // This distribution describes reported events, not all keystrokes; Chrome drops sub-threshold durations.
      if (!entries.length) throw new Error('no keyboard Event Timing entries reached the 16 ms threshold')
      const stats = (values: number[]) => ({ medianMs: median(values)!, p95Ms: percentile(values, 0.95)! })
      return { count: entries.length, duration: stats(entries.map((entry) => entry.duration)), inputDelay: stats(entries.map((entry) => entry.delay!)) }
    })
    return { firstBuildMs, firstLoad: { cold, warm }, sendToResponse, ttft, switch: switches, streaming, memory, reconnect, keypress }
  } finally {
    instance.fake.chunkMs = pace
    signal?.removeEventListener('abort', cancel)
    await browser.close()
  }
}

async function waitForView(page: Page, id: number) {
  await page.waitForFunction((id) => window.perfProbe.events.some((event) => event.conversation === id), id)
}
