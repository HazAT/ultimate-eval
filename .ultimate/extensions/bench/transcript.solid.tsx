/** @jsxImportSource @solidjs/web */
// A compact transcript viewer: the conversations of a run as tabs, messages readable, tool calls folded to one line.
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.solid.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs.solid.tsx'
import { cn, errorMessage, formatTime, useAction, useExtensionUiState } from '@/sdk/solid'
import { Note } from './parts.solid.tsx'
import { TranscriptAction, usd } from './types.ts'
import type { Entry, Run } from './types.ts'

type Conversation = Run['conversations'][number]

/** Who a conversation is, in the words the run uses: @ultimate, coordinator, worker, lander. */
const roleOf = (c: Conversation | undefined, id: number) => {
  if (!c) return id === 1 ? 'root' : 'conversation'
  if (c.label === 'agent') return '@ultimate'
  if (c.label === 'lander') return 'lander'
  if (id === 1) return 'root'
  return c.label ?? 'conversation'
}
const ORDER = ['@ultimate', 'coordinator', 'worker', 'lander', 'root']
const rank = (role: string) => (ORDER.includes(role) ? ORDER.indexOf(role) : ORDER.length)

export function Transcripts(props: { id: string; run: Run }) {
  const list = createMemo(() => {
    const byId = new Map(props.run.conversations.map((c) => [c.id, c]))
    return props.run.transcripts
      .map((id) => {
        const conversation = byId.get(id)
        const role = roleOf(conversation, id)
        const title = conversation?.title && !conversation.title.startsWith('@') ? conversation.title : undefined
        return { id, role, title }
      })
      .toSorted((a, b) => rank(a.role) - rank(b.role) || a.id - b.id)
  })
  const [chosen, setChosen] = useExtensionUiState<string | null>('conversation', null)
  const shown = () => {
    const ids = list().map((c) => String(c.id))
    const stored = chosen()
    return stored !== null && ids.includes(stored) ? stored : ids[0]
  }
  return (
    <Show when={shown()} fallback={<Note>No transcripts were collected for this run.</Note>}>
      {(value) => (
        <Tabs
          aria-label={`Transcripts of run ${props.id}`}
          bind={[value, setChosen]}
          class="flex min-w-0 flex-col gap-4 @4xl:flex-row"
        >
          <TabsList
            aria-label={`Conversations of run ${props.id}`}
            class="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] items-stretch gap-x-2 border-0 p-0 @4xl:flex @4xl:w-52 @4xl:flex-col"
          >
            <For each={list()} keyed={(c) => c.id}>
              {(c) => (
                <TabsTab
                  class="h-auto min-w-0 items-baseline justify-start gap-2 rounded-md px-2 py-1 text-left"
                  title={c().title}
                  value={String(c().id)}
                >
                  <span class="w-9 shrink-0 text-muted-foreground/70">#{c().id}</span>
                  <span class="min-w-0 truncate font-sans text-[12.5px] text-foreground">
                    {c().title ?? <span class="font-mono text-[11.5px]">{c().role}</span>}
                  </span>
                  <Show when={c().title && c().role !== 'coordinator'}>
                    <span class="ml-auto shrink-0 text-[10.5px] text-muted-foreground/70">{c().role}</span>
                  </Show>
                </TabsTab>
              )}
            </For>
          </TabsList>
          <For each={list()} keyed={(c) => c.id}>
            {(c) => (
              <TabsPanel class="min-w-0 flex-1" value={String(c().id)}>
                <Transcript conversation={c().id} id={props.id} />
              </TabsPanel>
            )}
          </For>
        </Tabs>
      )}
    </Show>
  )
}

function Transcript(props: { id: string; conversation: number }) {
  const [before, setBefore] = createSignal<number>()
  const page = useAction(TranscriptAction, {
    get id() {
      return props.id
    },
    get conversation() {
      return props.conversation
    },
    get before() {
      return before()
    },
  })
  return (
    <Switch fallback={<Note>loading…</Note>}>
      <Match when={page.error()}>{(error) => <Note class="text-error">{errorMessage(error())}</Note>}</Match>
      <Match when={page.data()}>
        {(data) => {
          const shown = createMemo(() => data().entries.filter(visible))
          const models = () => [...new Set(data().entries.flatMap((e) => (e.model ? [e.model] : [])))]
          const cost = () => data().entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
          const pager = 'h-auto p-0 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground'
          return (
            <div class="min-w-0">
              <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground/70">
                <span>
                  entries {data().start + 1}–{data().start + data().entries.length} of {data().total}
                  {models().length > 0 && ` · ${models().join(', ')}`}
                  {cost() > 0 && ` · ${usd(cost())} on this page`}
                </span>
                <Show when={data().start > 0}>
                  <Button
                    aria-label={`Earlier entries of #${props.conversation}`}
                    class={pager}
                    onClick={() => setBefore(data().start)}
                    size={null}
                    variant={null}
                  >
                    ← earlier
                  </Button>
                </Show>
                <Show when={before() !== undefined}>
                  <Button
                    aria-label={`Latest entries of #${props.conversation}`}
                    class={pager}
                    onClick={() => setBefore(undefined)}
                    size={null}
                    variant={null}
                  >
                    latest →
                  </Button>
                </Show>
              </div>
              <Show when={shown().length > 0} fallback={<Note>Nothing readable on this page.</Note>}>
                <ol class="space-y-1">
                  <For each={shown()} keyed={(e) => e.id}>
                    {(e) => <Row conversation={props.conversation} entry={e()} />}
                  </For>
                </ol>
              </Show>
            </div>
          )
        }}
      </Match>
    </Switch>
  )
}

/** The system prompt and empty bookkeeping rows say nothing here. */
const visible = (e: Entry) =>
  e.role !== 'system' && (e.text.trim() !== '' || e.calls.length > 0 || e.role === 'toolResult' || e.data !== undefined)

const meta = (e: Entry) =>
  [e.at !== undefined && formatTime(e.at, true), e.costUsd !== undefined && usd(e.costUsd)].filter(Boolean).join(' · ')

function Row(props: { conversation: number; entry: Entry }) {
  const e = () => props.entry
  /** Each fold names its conversation and entry, so no two on the page share a name. */
  const name = (what: string) => `${what} · #${props.conversation} entry ${e().id}`
  return (
    <Switch
      fallback={
        // A user-role row: the person's input, or a note, message or report delivered as one.
        <li
          class={cn(
            'min-w-0 rounded-md px-2.5 py-1.5',
            e().kind === 'pi.user' ? 'border-l-2 border-l-brand/60 bg-brand/5' : 'bg-muted/30',
          )}
        >
          <p class="mb-0.5 font-mono text-[10.5px] text-muted-foreground/70">
            {e().kind === 'pi.user' ? 'user' : e().kind}
            {e().at !== undefined && ` · ${formatTime(e().at!, true)}`}
          </p>
          <p
            class={cn(
              'text-[12.5px] whitespace-pre-wrap',
              e().kind === 'pi.user' ? 'text-foreground' : 'line-clamp-6 text-foreground/80',
            )}
          >
            {e().text}
          </p>
        </li>
      }
    >
      <Match when={e().role === 'toolResult'}>
        <li class="min-w-0 pl-4">
          <Fold
            body={e().text || '(empty)'}
            error={e().isError}
            label={
              <span class={e().isError ? 'text-error' : 'text-muted-foreground/70'}>
                {e().isError ? `${e().tool ?? 'tool'} failed` : '↳'}
              </span>
            }
            name={name(`Show ${e().tool ?? 'tool'} result`)}
          />
        </li>
      </Match>
      <Match when={!e().role && e().data !== undefined}>
        <DataRow entry={e()} name={name('Show data')} />
      </Match>
      <Match when={e().role === 'assistant'}>
        <li class="min-w-0 py-1">
          <Show when={e().text.trim()}>
            <Markdown class="text-[13px] leading-relaxed" text={e().text} />
          </Show>
          <For each={e().calls}>
            {(call, i) => (
              <Fold
                body={call.args}
                label={<span class="text-foreground/85">{call.name}</span>}
                meta={i() === 0 ? meta(e()) : undefined}
                name={name(`Show ${call.name ?? 'tool'} call ${i() + 1}`)}
              />
            )}
          </For>
          <Show when={e().calls.length === 0}>
            <p class="font-mono text-[10.5px] text-muted-foreground/60">{meta(e())}</p>
          </Show>
        </li>
      </Match>
    </Switch>
  )
}

/** An entry without a message (the lander's steps, bookkeeping): one line, its data a click away. */
function DataRow(props: { entry: Entry; name: string }) {
  const d = createMemo(() => parse(props.entry.data))
  const what = () => {
    const data = d()
    if (typeof data?.outcome === 'string')
      return `${data.outcome}${typeof data.sha === 'string' ? ` ${data.sha.slice(0, 7)}` : ''}`
    return typeof data?.step === 'string' ? data.step : props.entry.kind
  }
  const who = () => (typeof d()?.conversationId === 'number' ? `#${d()!.conversationId as number} ` : '')
  const at = () => (typeof d()?.at === 'number' ? formatTime(d()!.at as number, true) : undefined)
  return (
    <li class="min-w-0">
      <Fold
        body={props.entry.data ?? ''}
        label={
          <span class={d()?.outcome === 'landed' ? 'text-success' : 'text-muted-foreground'}>
            {who()}
            {what()}
          </span>
        }
        meta={at()}
        name={props.name}
        preview={false}
      />
    </li>
  )
}

const parse = (text: string | undefined) => {
  try {
    const value: unknown = JSON.parse(text ?? '')
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** One quiet line that opens to its raw text. */
function Fold(props: {
  name: string
  label: JSX.Element
  meta?: string
  body: string
  error?: boolean
  preview?: boolean
}) {
  return (
    <Collapsible class="group/fold min-w-0">
      <CollapsibleTrigger
        aria-label={props.name}
        class="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left font-mono text-[11px] outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight class="size-3 shrink-0 text-muted-foreground/60 transition-transform group-data-open/fold:rotate-90" />
        <span class="shrink-0 whitespace-nowrap">{props.label}</span>
        <Show when={props.preview !== false}>
          <span class="min-w-0 truncate text-muted-foreground/50 group-data-open/fold:hidden">
            {props.body.slice(0, 160)}
          </span>
        </Show>
        <Show when={props.meta}>
          <span class="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground/60">{props.meta}</span>
        </Show>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre
          class={cn(
            'mt-0.5 mb-1 ml-4.5 max-h-80 overflow-auto rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-foreground/80',
            props.error && 'text-error',
          )}
        >
          {props.body}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
