/** Linear interpolation between adjacent samples, including the midpoint for an even median. */
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const rank = fraction * (sorted.length - 1)
  const lower = sorted[Math.floor(rank)]!
  const upper = sorted[Math.ceil(rank)]!
  return lower + (upper - lower) * (rank % 1)
}

export const median = (values: number[]) => percentile(values, 0.5)

export function keypressStats(samples: (number | null)[], expected: number) {
  const values = samples.filter((ms): ms is number => ms !== null && Number.isFinite(ms) && ms >= 0)
  if (!expected || samples.length !== expected || values.length !== expected)
    throw new Error(`paint observed for ${values.length} of ${expected} physical keys (${samples.length} keydowns)`)
  return { count: values.length, duration: { medianMs: median(values)!, p95Ms: percentile(values, 0.95)! } }
}

type Bounds = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>
type VisibleElement = Pick<Element, 'isConnected' | 'closest' | 'checkVisibility'> & { getBoundingClientRect(): Bounds }

export function liveRowVisible(row: VisibleElement, bounds: Bounds, covered: boolean, rect?: Bounds) {
  if (covered || !row.isConnected || row.closest('#resume') ||
      !row.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
  rect ??= row.getBoundingClientRect()
  return Math.max(bounds.top, rect.top) < Math.min(bounds.bottom, rect.bottom) &&
    Math.max(bounds.left, rect.left) < Math.min(bounds.right, rect.right)
}

export function targetRowVisible(entry: number | null, visible: (selector: string) => boolean) {
  // The empty sidebar target is always reached from a nonempty transcript. Oct 26 predates its data-ui hook.
  return visible(entry === null ? '[data-ui="empty-state"], [class~="min-h-[55vh]"]' : `[data-entry-id="${entry}"]`)
}

type SourceEvent = { t: number; name: string; connection: number; url: string; conversation?: number }
type Watch = { key?: number; echoed?: number; marks: (number | null)[] }
type Target = { visible: number; settled: number }

export type Probe = {
  events: SourceEvent[]
  timings: { t: number; duration: number; type: string; name: string }[]
  coverMs: number | null
  startTarget: (entry: number | null, quietMs: number) => void
  target?: Target
  stopTarget: () => void
  watchText: (user: string, markers: string[]) => void
  stopText: () => void
  watch?: Watch
  watchKeys: (element: HTMLTextAreaElement, keys: string) => void
  keys?: (number | null)[]
  frames?: number[]
}

declare global {
  interface Window { perfProbe: Probe }
}

// Playwright serializes this function and the supplied predicates; all other runtime dependencies are local.
export function installProbe(rowVisible: typeof liveRowVisible, targetVisible: typeof targetRowVisible) {
  sessionStorage.setItem('ultimate.driven', '1')
  // Like Ultimate's browser tool, keep the warm-up tab and the measured tab from sharing shell selections.
  sessionStorage.setItem('ultimate.detached', '1')
  const probe: Probe = { events: [], timings: [], coverMs: null, startTarget, stopTarget, watchText, stopText, watchKeys }
  window.perfProbe = probe
  const Native = window.EventSource
  let opened = 0
  window.EventSource = class extends Native {
    constructor(input: string | URL, init?: EventSourceInit) {
      super(input, init)
      let connection = 0
      const url = this.url
      for (const name of ['open', 'stream', 'view']) {
        this.addEventListener(name, (event) => {
          // EventSource can open a fresh HTTP stream on the same JavaScript object after a disconnect.
          if (name === 'open') connection = ++opened
          // Oct 26 sent bare view JSON; later views prefix it with a subscription ID and a newline.
          const id = name === 'view' && /^(?:\d+\n)?\{"conversation":\{"id":(\d+)/.exec((event as MessageEvent<string>).data.slice(0, 100))?.[1]
          const t = performance.now()
          probe.events.push({ t, name, connection, url, ...(id ? { conversation: Number(id) } : {}) })
        })
      }
    }
  }
  function observeTiming(type: string) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.timings.push({ t: entry.startTime, duration: entry.duration, type, name: entry.name })
    }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
  }
  observeTiming('longtask')
  observeTiming('long-animation-frame')

  const cover = () => document.getElementById('resume')?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) === true
  // The inline HTML restores the cover before the app mounts. Only count it if it survives to a frame.
  const coverObserver = new MutationObserver(() => {
    if (!document.getElementById('resume')) return
    coverObserver.disconnect()
    requestAnimationFrame(() => { if (cover()) probe.coverMs = performance.now() })
  })
  coverObserver.observe(document, { childList: true, subtree: true })
  addEventListener('DOMContentLoaded', () => coverObserver.disconnect(), { once: true })

  function transcript() {
    // The two oldest React eras use StickToBottom's role=log, then its scroller and content divs.
    return document.querySelector<HTMLElement>('#app [data-ui="transcript"], #app [role="log"] > div > div')
  }
  const boundsOf = (content: HTMLElement) => {
    const scroll = content.parentElement!.getBoundingClientRect()
    return { top: Math.max(0, scroll.top), bottom: Math.min(innerHeight, scroll.bottom),
      left: Math.max(0, scroll.left), right: Math.min(innerWidth, scroll.right) }
  }
  const visible = (root: HTMLElement, selector: string) => {
    const bounds = boundsOf(root)
    return [...root.querySelectorAll<HTMLElement>(selector)].some((row) => rowVisible(row, bounds, false))
  }
  let stopWatchingTarget: (() => void) | undefined
  function stopTarget() {
    stopWatchingTarget?.()
    stopWatchingTarget = undefined
    delete probe.target
  }
  function startTarget(entry: number | null, quietMs: number) {
    stopTarget()
    let observed: HTMLElement | null = null
    let visibleAt: number | undefined
    let lastMutation = 0
    const changes = new MutationObserver(() => { lastMutation = performance.now() })
    function observe(root: HTMLElement | null) {
      if (root === observed) return
      changes.disconnect()
      observed = root
      lastMutation = performance.now()
      if (root && quietMs) changes.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    }
    function frame() {
      const root = transcript()
      observe(root)
      if (root && !cover() && targetVisible(entry, (selector) => visible(root, selector))) {
        const now = performance.now()
        // A retained row may already be visible at a rendering opportunity, before any fresh SSE view.
        visibleAt ??= now
        const settled = Math.max(visibleAt, lastMutation) + quietMs
        if (now >= settled) {
          changes.disconnect()
          probe.target = { visible: visibleAt, settled }
          return
        }
      }
      pending = requestAnimationFrame(frame)
    }
    observe(transcript())
    let pending = requestAnimationFrame(frame)
    stopWatchingTarget = () => { changes.disconnect(); cancelAnimationFrame(pending) }
  }

  let stopWatchingText: (() => void) | undefined
  function stopText() {
    stopWatchingText?.()
    stopWatchingText = undefined
    delete probe.watch
  }
  function watchText(user: string, markers: string[]) {
    stopText()
    const content = transcript()
    if (!content || cover()) throw new Error('live transcript is not visible')
    const scroll = content.parentElement!
    const watch: Watch = { marks: markers.map(() => null) }
    probe.watch = watch
    let frame = 0
    const selector = '[data-from="assistant"], [data-from="user"]'
    // A partial AssistantView has no persisted entry ID. Observe the same Message rows in all eras.
    const tail = [...content.querySelectorAll(selector)].at(-1)
    let userRow: HTMLElement | undefined, assistantRow: HTMLElement | undefined
    function inspect(row: HTMLElement | null) {
      if (!row || row === tail || !content!.contains(row)) return
      if (tail?.isConnected && !(tail.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)) return
      if (row.dataset.from === 'user') userRow = row
      else assistantRow = row
    }
    function markVisible() {
      frame = 0
      if (cover()) return
      const bounds = boundsOf(content!)
      const t = performance.now()
      if (watch.echoed === undefined && userRow?.textContent?.includes(user) && rowVisible(userRow, bounds, false)) watch.echoed = t
      if (!assistantRow || !rowVisible(assistantRow, bounds, false)) return
      const text = assistantRow.textContent ?? ''
      for (const [i, marker] of markers.entries()) {
        if (watch.marks[i] !== null) continue
        const at = text.indexOf(marker)
        if (at < 0) break // Later markers cannot have arrived yet.
        // A long row can intersect the viewport while a marker lies above or below it. Check the text's own bounds.
        const walker = document.createTreeWalker(assistantRow, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        const end = at + marker.length
        let offset = 0
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const next = offset + node.nodeValue!.length
          if (at >= offset && at < next) range.setStart(node, at - offset)
          if (end > offset && end <= next) {
            range.setEnd(node, end - offset)
            const words = range.startContainer.parentElement ?? assistantRow
            if ([...range.getClientRects()].some((rect) => rowVisible(words, bounds, false, rect))) watch.marks[i] = t
            break
          }
          offset = next
        }
      }
    }
    const schedule = () => { if (watch.key !== undefined && !frame) frame = requestAnimationFrame(markVisible) }
    const changes = new MutationObserver((records) => {
      if (watch.key === undefined) return
      for (const record of records) {
        const row = (record.target instanceof HTMLElement ? record.target : record.target.parentElement)?.closest<HTMLElement>(selector)
        if (row) { inspect(row); continue }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches(selector)) inspect(node)
          else for (const row of node.querySelectorAll<HTMLElement>(selector)) inspect(row)
        }
      }
      schedule()
    })
    // Only changed nodes under the live transcript, and at most one visibility check per frame on the new rows.
    changes.observe(content, { subtree: true, childList: true, characterData: true })
    scroll.addEventListener('scroll', schedule, { passive: true })
    stopWatchingText = () => {
      changes.disconnect()
      scroll.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }

  let stopWatchingKeys: (() => void) | undefined
  function watchKeys(element: HTMLTextAreaElement, keys: string) {
    if (!stopWatchingKeys) observeTiming('event')
    stopWatchingKeys?.()
    const observations: (number | null)[] = []
    probe.keys = observations
    const listen = (event: KeyboardEvent) => {
      if (event.target !== element || event.repeat || event.key !== keys[observations.length]) return
      const index = observations.push(null) - 1
      const expected = element.value + event.key
      const paint = () => requestAnimationFrame(() => {
        if (element.isConnected && !cover() && element.value.startsWith(expected)) {
          // Yield after this rendering opportunity so fast keys still get one observation, not zero Event Timing entries.
          setTimeout(() => { observations[index] = performance.now() - event.timeStamp }, 0)
        } else if (element.isConnected && probe.keys === observations) paint()
      })
      paint()
    }
    addEventListener('keydown', listen, true)
    stopWatchingKeys = () => removeEventListener('keydown', listen, true)
  }
  addEventListener('keydown', (event) => {
    if (probe.watch && event.key === 'Enter' && event.target instanceof HTMLTextAreaElement && !event.target.closest('#resume'))
      probe.watch.key ??= event.timeStamp
  }, true)
}
