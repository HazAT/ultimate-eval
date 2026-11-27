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

export type Probe = {
  events: { t: number; name: string; connection: number; url: string; conversation?: number }[]
  timings: { t: number; duration: number; type: string; name: string; delay?: number }[]
  lastMutation: number
  watch?: { user: string; prefix?: string; end: string; key?: number; echoed?: number; first?: number; done?: number }
  frames?: number[]
}

declare global {
  interface Window { perfProbe: Probe }
}

// Playwright serializes this function; all runtime dependencies must be local.
export function installProbe() {
  sessionStorage.setItem('ultimate.driven', '1')
  // Like Ultimate's browser tool, keep the warm-up tab and the measured tab from sharing shell selections.
  sessionStorage.setItem('ultimate.detached', '1')
  const probe: Probe = { events: [], timings: [], lastMutation: 0 }
  window.perfProbe = probe
  const Native = window.EventSource
  let opened = 0
  window.EventSource = class extends Native {
    constructor(input: string | URL, init?: EventSourceInit) {
      super(input, init)
      let connection = 0
      const url = this.url
      probe.events.push({ t: performance.now(), name: 'construct', connection, url })
      for (const name of ['open', 'error', 'message', 'stream', 'system', 'conversations', 'conversationsOps',
        'view', 'ops', 'ui', 'uiOps', 'doc', 'docOps', 'tasks', 'tasksOps', 'notice', 'read']) {
        this.addEventListener(name, (event) => {
          // EventSource can open a fresh HTTP stream on the same JavaScript object after a disconnect.
          if (name === 'open') connection = ++opened
          // Oct 26 sent bare view JSON; later views prefix it with a subscription ID and a newline.
          const id = name === 'view' && /^(?:\d+\n)?\{"conversation":\{"id":(\d+)/.exec((event as MessageEvent<string>).data.slice(0, 100))?.[1]
          probe.events.push({ t: performance.now(), name, connection, url, ...(id ? { conversation: Number(id) } : {}) })
        })
      }
    }
  }
  for (const type of ['longtask', 'long-animation-frame', 'event']) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.timings.push({
        t: entry.startTime, duration: entry.duration, type, name: entry.name,
        ...(type === 'event' ? { delay: (entry as PerformanceEventTiming).processingStart - entry.startTime } : {}),
      })
    }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
  }
  window.addEventListener('keydown', (event) => {
    const watch = probe.watch
    if (watch && event.key === 'Enter' && event.target instanceof HTMLTextAreaElement) watch.key ??= performance.now()
  }, { capture: true })
  new MutationObserver((records) => {
    const t = probe.lastMutation = performance.now()
    const watch = probe.watch
    if (watch?.key === undefined || watch.done !== undefined) return
    const inspect = (node: Node) => {
      if (!node.isConnected || node.parentElement?.closest('textarea,script,style')) return
      const value = node.nodeValue?.trim()
      if (!value) return
      if (value === watch.user) watch.echoed ??= t
      // Live answers aren't wrapped in a persisted data-entry-id yet, in any of the eras.
      if (watch.prefix && (value.startsWith(watch.prefix) || watch.prefix.startsWith(value))) watch.first ??= t
      if (value.includes(watch.end)) watch.done ??= t
    }
    for (const record of records) {
      if (record.type === 'characterData') inspect(record.target)
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) inspect(node)
        else {
          const texts = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
          while (texts.nextNode()) inspect(texts.currentNode)
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
}
