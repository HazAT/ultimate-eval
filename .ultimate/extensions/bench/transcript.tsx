// A compact transcript viewer: the conversations of a run as tabs, messages readable, tool calls folded to one line.
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { cn, errorMessage, formatTime, useAction, useExtensionUiState } from '@/sdk'
import { Note } from './parts.tsx'
import { TranscriptAction, usd } from './types.ts'
import type { Entry, Run } from './types.ts'

/** Who a conversation is, in the words the run uses: @ultimate, coordinator, worker, lander. */
const roleOf = (c: Run['conversations'][number] | undefined, id: number) => {
  if (!c) return id === 1 ? 'root' : 'conversation'
  if (c.label === 'agent') return '@ultimate'
  if (c.label === 'lander') return 'lander'
  if (id === 1) return 'root'
  return c.label ?? 'conversation'
}
const ORDER = ['@ultimate', 'coordinator', 'worker', 'lander', 'root']

export function Transcripts({ id, run }: { id: string; run: Run }) {
  const byId = new Map(run.conversations.map((c) => [c.id, c]))
  const list = [...run.transcripts].sort((a, b) => {
    const ra = ORDER.indexOf(roleOf(byId.get(a), a))
    const rb = ORDER.indexOf(roleOf(byId.get(b), b))
    return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb) || a - b
  })
  const [chosen, setChosen] = useExtensionUiState<number | null>('conversation', null)
  const shown = chosen !== null && list.includes(chosen) ? chosen : list[0]
  if (shown === undefined) return <Note>No transcripts were collected for this run.</Note>
  return (
    <div className="flex min-w-0 flex-col gap-4 @4xl:flex-row">
      <nav className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-2 @4xl:block @4xl:w-52">
        {list.map((c) => {
          const conv = byId.get(c)
          const title = conv?.title && !conv.title.startsWith('@') ? conv.title : undefined
          return (
            <button
              className={cn(
                'flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring @4xl:w-full',
                c === shown && 'bg-accent',
              )}
              key={c}
              onClick={() => setChosen(c)}
              title={title}
              type="button"
            >
              <span className="w-9 shrink-0 font-mono text-[11px] text-muted-foreground/70">#{c}</span>
              <span className="min-w-0 truncate text-[12.5px]">
                {title ?? <span className="font-mono text-[11.5px]">{roleOf(conv, c)}</span>}
              </span>
              {title && roleOf(conv, c) !== 'coordinator' && (
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                  {roleOf(conv, c)}
                </span>
              )}
            </button>
          )
        })}
      </nav>
      <div className="min-w-0 flex-1">
        <Transcript conversation={shown} id={id} key={`${id}-${shown}`} />
      </div>
    </div>
  )
}

function Transcript({ id, conversation }: { id: string; conversation: number }) {
  const [before, setBefore] = useState<number | undefined>()
  const page = useAction(TranscriptAction, { id, conversation, before })
  if (page.error) return <Note className="text-error">{errorMessage(page.error)}</Note>
  if (!page.data) return <Note>loading…</Note>
  const { total, start, entries } = page.data
  const shown = entries.filter(visible)
  const models = [...new Set(entries.flatMap((e) => (e.model ? [e.model] : [])))]
  const cost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground/70">
        <span>
          entries {start + 1}–{start + entries.length} of {total}
          {models.length > 0 && ` · ${models.join(', ')}`}
          {cost > 0 && ` · ${usd(cost)} on this page`}
        </span>
        {start > 0 && (
          <button
            className="cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={() => setBefore(start)}
            type="button"
          >
            ← earlier
          </button>
        )}
        {before !== undefined && (
          <button
            className="cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={() => setBefore(undefined)}
            type="button"
          >
            latest →
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <Note>Nothing readable on this page.</Note>
      ) : (
        <ol className="space-y-1">
          {shown.map((e) => (
            <Row entry={e} key={e.id} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** The system prompt and empty bookkeeping rows say nothing here. */
const visible = (e: Entry) =>
  e.role !== 'system' &&
  (e.text.trim() !== '' || e.calls.length > 0 || e.role === 'toolResult' || e.data !== undefined)

function Row({ entry: e }: { entry: Entry }) {
  if (e.role === 'toolResult') return <ToolResult entry={e} />
  if (!e.role && e.data !== undefined) return <DataRow entry={e} />
  if (e.role === 'assistant')
    return (
      <li className="min-w-0 py-1">
        {e.text.trim() && (
          <div className="text-[13px] leading-relaxed">
            <MessageResponse>{e.text}</MessageResponse>
          </div>
        )}
        {e.calls.map((call, i) => (
          <Fold
            key={i}
            label={<span className="text-foreground/85">{call.name}</span>}
            meta={i === 0 ? meta(e) : undefined}
            body={call.args}
          />
        ))}
        {e.calls.length === 0 && <p className="font-mono text-[10.5px] text-muted-foreground/60">{meta(e)}</p>}
      </li>
    )
  // A user-role row: the person's input, or a note, message or report delivered as one.
  const input = e.kind === 'pi.user'
  return (
    <li
      className={cn(
        'min-w-0 rounded-md px-2.5 py-1.5',
        input ? 'border-l-2 border-l-brand/60 bg-brand/5' : 'bg-muted/30',
      )}
    >
      <p className="mb-0.5 font-mono text-[10.5px] text-muted-foreground/70">
        {input ? 'user' : e.kind}
        {e.at !== undefined && ` · ${formatTime(e.at, true)}`}
      </p>
      <p
        className={cn(
          'text-[12.5px] whitespace-pre-wrap',
          input ? 'text-foreground' : 'line-clamp-6 text-foreground/80',
        )}
      >
        {e.text}
      </p>
    </li>
  )
}

/** An entry without a message (the lander's steps, bookkeeping): one line, its data a click away. */
function DataRow({ entry: e }: { entry: Entry }) {
  const d = parse(e.data)
  const what =
    typeof d?.outcome === 'string'
      ? `${d.outcome}${typeof d.sha === 'string' ? ` ${d.sha.slice(0, 7)}` : ''}`
      : typeof d?.step === 'string'
        ? d.step
        : e.kind
  const who = typeof d?.conversationId === 'number' ? `#${d.conversationId} ` : ''
  const at = typeof d?.at === 'number' ? formatTime(d.at, true) : undefined
  return (
    <li className="min-w-0">
      <Fold
        body={e.data ?? ''}
        label={
          <span className={cn(d?.outcome === 'landed' ? 'text-success' : 'text-muted-foreground')}>
            {who}
            {what}
          </span>
        }
        meta={at}
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

const meta = (e: Entry) =>
  [e.at !== undefined && formatTime(e.at, true), e.costUsd !== undefined && usd(e.costUsd)]
    .filter(Boolean)
    .join(' · ')

function ToolResult({ entry: e }: { entry: Entry }) {
  return (
    <li className="min-w-0 pl-4">
    <Fold
      body={e.text || '(empty)'}
      error={e.isError}
      label={
        <span className={cn(e.isError ? 'text-error' : 'text-muted-foreground/70')}>
          {e.isError ? `${e.tool ?? 'tool'} failed` : '↳'}
        </span>
      }
    />
    </li>
  )
}

/** One quiet line that opens to its raw text. */
function Fold({
  label,
  meta,
  body,
  error,
  preview = true,
}: {
  label: ReactNode
  meta?: string
  body: string
  error?: boolean
  preview?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left font-mono text-[11px] outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 whitespace-nowrap">{label}</span>
        {!open && preview && (
          <span className="min-w-0 truncate text-muted-foreground/50">{body.slice(0, 160)}</span>
        )}
        {meta && (
          <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground/60">{meta}</span>
        )}
      </button>
      {open && (
        <pre
          className={cn(
            'mt-0.5 mb-1 ml-4.5 max-h-80 overflow-auto rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-foreground/80',
            error && 'text-error',
          )}
        >
          {body}
        </pre>
      )}
    </div>
  )
}
