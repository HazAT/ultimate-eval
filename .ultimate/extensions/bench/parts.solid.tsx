/** @jsxImportSource @solidjs/web */
// Small shared pieces of the Bench surface: status dots, sections, boxes, empty notes, label/value facts.
import type { JSX } from '@solidjs/web'
import { For, Show } from 'solid-js'
import { cn } from '@/sdk/solid'
import { toneDot } from './types.ts'
import type { Tone } from './types.ts'

export function Dot(props: { tone: Tone | 'live'; pulse?: boolean }) {
  return (
    <span
      class={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        props.tone === 'live' ? 'bg-brand' : toneDot[props.tone],
        props.pulse && 'animate-pulse-dot',
      )}
    />
  )
}

/** A quiet section: a mono label, an optional aside on its right, then its content. */
export function Section(props: {
  title: JSX.Element
  aside?: JSX.Element
  class?: string
  children: JSX.Element
}) {
  return (
    <section class={props.class}>
      <div class="mb-2 flex items-baseline gap-3">
        <h2 class="section-label">{props.title}</h2>
        <Show when={props.aside}>
          <span class="ml-auto font-mono text-[11px] text-muted-foreground/70">{props.aside}</span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

/** A bordered box like the System surface's. */
export function Box(props: { class?: string; children: JSX.Element }) {
  return <div class={cn('rounded-lg border border-border/70 bg-card/40', props.class)}>{props.children}</div>
}

export function Note(props: { class?: string; children: JSX.Element }) {
  return <p class={cn('font-mono text-[11.5px] text-muted-foreground/70', props.class)}>{props.children}</p>
}

/** A label/value grid for meta. */
export function Facts(props: { rows: [string, string][] }) {
  return (
    <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]">
      <For each={props.rows}>
        {(row) => (
          <div class="contents">
            <dt class="truncate text-muted-foreground/70">{row[0]}</dt>
            <dd class="min-w-0 break-words text-foreground/85">{row[1]}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}

/** Mono tab styling shared by the run tabs and the transcript picker: quiet, no frame. */
export const tabList = 'flex-wrap gap-0.5 border-0 p-0'
