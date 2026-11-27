/**
 * The instance under test, seen the way its web UI sees it: the `/api/events` stream (conversation list, task graph,
 * documents of conversation 1 and of the standing @ultimate), and the user's own HTTP calls. Nothing here reads the
 * instance's sqlite; that waits until the server has stopped (score.ts).
 */

/** One stored entry as `/api/conversations/:id/history` returns it. */
export type Entry = {
  id: number
  kind: string
  conversationId: number
  model?: {
    role: string
    content: unknown
    timestamp?: number
    usage?: Usage
    provider?: string
    model?: string
    stopReason?: string
  }[]
  data?: unknown
}
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { total: number }
}
export type Summary = {
  id: number
  parentConversationId?: number
  branchOf?: { conversationId: number; at: number }
  label?: string
  title?: string
  cwd?: string
  busy: boolean
  inputAt?: number
  answerAt?: number
}
export type Question = {
  text: string
  kind: 'choice' | 'multi' | 'confirm' | 'text' | 'scale'
  ref?: string
  options?: { label: string; key?: string; detail?: string; recommended?: boolean }[]
  scale?: { min: number; max: number; low?: string; high?: string }
}
export type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number
  reply: boolean
  state: string
  /** The message this one answers. */
  re?: number
  /** The sender's answer entry this message carried down to a branch: an answer the user never sees. */
  routed?: number
  questions?: Question[]
  /** A message to or from another project (`ultimate.tell`): its key, and the id it got on the other board. */
  remote?: { project: string; machine: string; key: string; id?: number }
  /** A progress note on a remote message, not its answer. */
  interim?: boolean
}

type Op =
  | ['r', unknown]
  | ['s', (string | number)[], unknown]
  | ['d', (string | number)[]]
  | ['a', (string | number)[], string]
  | ['t', (string | number)[], number]
  | ['p', (string | number)[], number, number, unknown[]]
  | ['m', (string | number)[], number[]]

/** Apply chord delta ops (the stream's `docOps`) to a plain JSON value, returning the new value. */
export function applyOps(value: unknown, ops: readonly Op[]): unknown {
  let root = structuredClone(value)
  for (const op of ops) {
    if (op[0] === 'r') {
      root = structuredClone(op[1])
      continue
    }
    const path = op[1]
    const parentPath = op[0] === 'p' || op[0] === 'm' ? path : path.slice(0, -1)
    let target = root as Record<string | number, unknown>
    for (const segment of parentPath) target = target[segment] as Record<string | number, unknown>
    const key = path[path.length - 1]!
    switch (op[0]) {
      case 's':
        target[key] = structuredClone(op[2])
        break
      case 'd':
        if (Array.isArray(target)) target.splice(key as number, 1)
        else delete target[key]
        break
      case 'a':
        target[key] = `${target[key] as string}${op[2]}`
        break
      case 't':
        target[key] = (target[key] as string).slice(op[2])
        break
      case 'p':
        ;(target as unknown as unknown[]).splice(op[2], op[3], ...structuredClone(op[4]))
        break
      case 'm': {
        const list = target as unknown as unknown[]
        const old = list.slice()
        op[2].forEach((from, i) => (list[i] = old[from]))
        break
      }
    }
  }
  return root
}

/** Open questions to the user: reply-expected messages to `user` that are delivered and unanswered. */
export const openQuestions = (board: { messages?: Message[] } | undefined) =>
  (board?.messages ?? []).filter((m) => m.to === 'user' && m.reply && m.state === 'delivered')

/**
 * @ultimate's final answers the user sees, among its `entries` after `seen`: assistant `stop` answers, except those the
 * board routed one-way down to a branch (the UI folds them out of the user's view). The routed record lands about
 * 100 ms after the entry, so while @ultimate (`ultimate`) is `busy` its newest entry waits for the next pass. Returns
 * the answers and the new `seen`.
 */
export function heardAnswers(
  entries: Entry[],
  seen: number,
  board: { messages?: Message[] } | undefined,
  ultimate: number,
  busy: boolean,
  textOf: (entry: Entry) => string,
) {
  const routed = new Set(
    (board?.messages ?? []).flatMap((m) => (m.from === ultimate && m.routed !== undefined ? [m.routed] : [])),
  )
  const last = busy ? entries.at(-1)?.id : undefined
  const answers: { at?: number; text: string }[] = []
  for (const entry of entries) {
    if (entry.id <= seen) continue
    if (entry.id === last) break
    seen = entry.id
    const m = entry.model?.[0]
    const text = textOf(entry).trim()
    if (m?.role === 'assistant' && m.stopReason === 'stop' && text && !routed.has(entry.id))
      answers.push({ at: m.timestamp, text })
  }
  return { answers, seen }
}

export class Instance {
  readonly base: string
  conversations: Summary[] = []
  tasks: { tasks?: Record<string, { state?: { status?: string } }> } = {}
  /** Documents by `<conversation>:<kind>`. */
  docs = new Map<string, unknown>()
  /**
   * Time (ms) the instance's state last really changed: a conversation, task or watched document that differs from what
   * we had. A reconnect's identical snapshot is no progress. The hang watchdog's clock.
   */
  lastProgress = Date.now()
  /** Since when (ms) the event stream is down: the core died or restarts; undefined while connected. */
  downSince?: number = Date.now()
  private controller = new AbortController()
  private seen = new Map<string, string>()
  private stream?: string
  private subs = new Map<number, { conversation: number; docs: string[] }>()
  /**
   * Ultimate before 2026-11-21 takes one subscription per `POST /api/events/<stream>/<sub>`; newer ones take a batch at
   * `POST /api/events/<stream>` and answer 404 at the old path (and old ones at the new). Learned on the first subscribe.
   */
  private perSubPath?: boolean
  private listeners = new Set<() => void>()

  constructor(base: string) {
    this.base = base
  }

  /** The subscription protocol the server took, once the first subscribe went through. */
  get protocol() {
    return this.perSubPath === undefined ? undefined : this.perSubPath ? 'per-sub' : 'batched'
  }

  private headers() {
    return { 'content-type': 'application/json', origin: this.base }
  }

  /** Every request ends after `ms`, or when the instance is closed. */
  private signal(ms = 30_000) {
    return AbortSignal.any([this.controller.signal, AbortSignal.timeout(ms)])
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(this.base + path, { headers: { origin: this.base }, signal: this.signal() })
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`)
    return (await response.json()) as T
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.base + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: this.signal(),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${text}`)
    return JSON.parse(text) as T
  }

  /** Call an extension action as the UI does (a loopback Origin makes it the user's). */
  async action<T>(extension: string, action: string, args: unknown): Promise<T> {
    return (await this.post<{ result: T }>(`/api/extensions/${extension}/actions/${action}`, { args }))
      .result
  }

  /** Type a message into a conversation, as the composer does (steer when it is busy). */
  submit(conversation: number, text: string) {
    const busy = this.conversations.find((c) => c.id === conversation)?.busy
    return this.post(`/api/conversations/${conversation}/submit`, {
      text,
      ...(busy ? { whenBusy: 'steer' } : {}),
    })
  }

  /** Every stored entry of a conversation, oldest first. */
  async history(conversation: number): Promise<Entry[]> {
    const all: Entry[] = []
    let before = Number.MAX_SAFE_INTEGER
    for (;;) {
      const page = await this.get<{ entries: Entry[]; before?: number }>(
        `/api/conversations/${conversation}/history?before=${before}`,
      )
      all.push(...page.entries)
      if (!page.before) break
      before = page.before
    }
    return all.reverse()
  }

  doc<T>(conversation: number, kind: string) {
    return this.docs.get(`${conversation}:${kind}`) as T | undefined
  }

  /** Is anything at all working: a busy conversation or a running task? */
  busy() {
    return (
      this.conversations.some((c) => c.busy) ||
      Object.values(this.tasks.tasks ?? {}).some((t) => t.state?.status === 'running')
    )
  }

  /** Resolve on the next change on the stream, or after `ms`. */
  changed(ms: number) {
    return new Promise<void>((done) => {
      const timer = setTimeout(finish, ms)
      function finish() {
        clearTimeout(timer)
        listeners.delete(finish)
        done()
      }
      const listeners = this.listeners
      listeners.add(finish)
    })
  }

  /** Watch `docs` on `conversation` (documents arrive as snapshots, then ops). */
  async watch(conversation: number, docs: string[]) {
    const sub = this.subs.size + 1
    this.subs.set(sub, { conversation, docs })
    if (this.stream) await this.subscribe([sub])
  }

  private async subscribe(subs: number[]) {
    if (!subs.length) return
    const specs = subs.map((sub) => ({ sub, ...this.subs.get(sub)!, view: false }))
    if (!this.perSubPath) {
      const response = await fetch(`${this.base}/api/events/${this.stream}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ subscribe: specs, unsubscribe: [] }),
        signal: this.signal(),
      })
      const text = await response.text()
      if (response.ok) {
        this.perSubPath = false
        const refused = Object.keys((JSON.parse(text) as { refused?: object }).refused ?? {})
        if (refused.length) throw new Error(`subscriptions refused: ${text}`)
        return
      }
      if (response.status !== 404 || this.perSubPath === false)
        throw new Error(`POST /api/events: ${response.status} ${text}`)
      this.perSubPath = true
    }
    for (const { sub, ...spec } of specs) await this.post(`/api/events/${this.stream}/${sub}`, spec)
  }

  /**
   * Open the event stream; it reconnects until `close`, as the UI does. Resolves once the first snapshot is in, and
   * rejects when that takes longer than `ms` or the instance is closed first.
   */
  async open(ms = 60_000) {
    let ready!: () => void
    let fail!: (error: Error) => void
    const first = new Promise<void>((done, reject) => ((ready = done), (fail = reject)))
    const timer = setTimeout(() => fail(new Error(`no event stream within ${ms / 1000} s`)), ms)
    this.controller.signal.addEventListener('abort', () => fail(new Error('closed')), { once: true })
    void (async () => {
      while (!this.controller.signal.aborted) {
        try {
          await this.read(() => ready())
        } catch {
          // A restart or a dropped stream: open it again.
        }
        this.downSince ??= Date.now()
        if (this.controller.signal.aborted) return
        await new Promise((done) => setTimeout(done, 500))
      }
    })()
    try {
      await first
    } finally {
      clearTimeout(timer)
    }
  }

  /** Note a value under `key`; true when it differs from the last one (real progress). */
  private changedValue(key: string, value: unknown) {
    const json = JSON.stringify(value)
    if (this.seen.get(key) === json) return false
    this.seen.set(key, json)
    return true
  }

  private async read(onReady: () => void) {
    // Only the connect is bounded: an open stream stays open (the server sends a heartbeat every 15 s).
    const connect = new AbortController()
    const timer = setTimeout(() => connect.abort(), 15_000)
    const response = await fetch(this.base + '/api/events', {
      headers: { origin: this.base },
      signal: AbortSignal.any([this.controller.signal, connect.signal]),
    }).finally(() => clearTimeout(timer))
    if (!response.ok || !response.body) throw new Error(`events: ${response.status}`)
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const name = /^event: (.*)$/m.exec(block)?.[1]
        const data = [...block.matchAll(/^data: (.*)$/gm)].map((m) => m[1]!)
        if (!name || !data.length) continue
        const payload = JSON.parse(data.at(-1)!)
        const sub = data.length > 1 ? Number(data[0]) : undefined
        let key: string
        if (name === 'stream') {
          this.stream = payload.id
          await this.subscribe([...this.subs.keys()])
          this.downSince = undefined
          onReady()
          continue
        } else if (name === 'conversations') {
          this.conversations = payload
          // The Oct 26 server sends the list directly, without a `stream` handshake. A list-only client is ready here.
          if (!this.subs.size) {
            this.downSince = undefined
            onReady()
          }
          key = name
        } else if (name === 'conversationsOps') {
          this.conversations = applyOps(this.conversations, payload) as Summary[]
          key = 'conversations'
        } else if (name === 'tasks') {
          this.tasks = payload
          key = name
        } else if (name === 'tasksOps') {
          this.tasks = applyOps(this.tasks, payload) as Instance['tasks']
          key = 'tasks'
        } else if ((name === 'doc' || name === 'docOps') && sub !== undefined) {
          key = `${this.subs.get(sub)?.conversation}:${payload.kind}`
          this.docs.set(key, name === 'doc' ? payload.value : applyOps(this.docs.get(key) ?? {}, payload.ops))
        } else continue
        if (
          !this.changedValue(
            key,
            key === 'conversations' ? this.conversations : key === 'tasks' ? this.tasks : this.docs.get(key),
          )
        )
          continue
        this.lastProgress = Date.now()
        for (const listener of [...this.listeners]) listener()
      }
    }
  }

  close() {
    this.controller.abort()
  }
}
