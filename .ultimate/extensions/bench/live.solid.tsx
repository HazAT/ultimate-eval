/** @jsxImportSource @solidjs/web */
// The run in progress: phase, elapsed against the budget, what the coordinators did, what was said last, and cancel.
import { Check, Eye, Square } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.solid.tsx'
import { api, cn, errorMessage, formatAgo, plural, useNow } from '@/sdk/solid'
import { Box, Dot, Note } from './parts.solid.tsx'
import { CancelAction, clock, short, when } from './types.ts'
import type { InProgress, Legacy, Running, Said as SaidLine } from './types.ts'

const PHASES = ['preparing', 'installing', 'starting', 'opening', 'running', 'collecting', 'accepting']

export function LiveRuns(props: { live: InProgress[]; onCancelled: () => void }) {
  return (
    <div class="space-y-3">
      <For each={props.live} keyed={(run) => run.id}>
        {(run) => (
          <Show
            when={run().kind === 'running' ? (run() as Running) : undefined}
            fallback={<LegacyCard run={run() as Legacy} />}
          >
            {(running) => <RunningCard onCancelled={props.onCancelled} run={running()} />}
          </Show>
        )}
      </For>
    </div>
  )
}

function LegacyCard(props: { run: Legacy }) {
  const now = useNow(10_000)
  return (
    <Box class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 font-mono text-[11.5px]">
      <Dot pulse tone="live" />
      <span class="text-foreground">running</span>
      <span class="text-muted-foreground">{short(props.run.commit)}</span>
      <span class="text-muted-foreground/70">started {formatAgo(props.run.launchedAt, now(), { ago: true })}</span>
      <span class="ml-auto text-muted-foreground/70">older runner · no live detail · stop it from its terminal</span>
    </Box>
  )
}

function RunningCard(props: { run: Running; onCancelled: () => void }) {
  const now = useNow(1000)
  const elapsed = () => (props.run.firstPromptAt ? now() - props.run.firstPromptAt : undefined)
  const share = () => Math.min(1, (elapsed() ?? 0) / (props.run.budgetMin * 60_000))
  /** The clock's colour: over the budget, in its last fifth, or fine. */
  const pressure = createMemo(() => {
    const ms = elapsed()
    if (ms === undefined) return 'fine'
    return ms > props.run.budgetMin * 60_000 ? 'over' : share() > 0.8 ? 'late' : 'fine'
  })
  const lastSaid = () => props.run.said.at(-1)
  const landed = () => props.run.coordinators.filter((c) => c.landed).length
  const others = () => props.run.busy.filter((b) => !props.run.coordinators.some((c) => c.id === b.id))
  return (
    <Box class="overflow-hidden">
      {/* What, where, and the one control */}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11.5px]">
        <Dot pulse tone="live" />
        <span class="text-foreground">{props.run.phase}</span>
        <span class="text-muted-foreground">
          {short(props.run.commit)} · {props.run.setup} · {props.run.scenario}
        </span>
        <Show when={props.run.repeat.total > 1}>
          <span class="text-muted-foreground/70">
            repeat {props.run.repeat.index}/{props.run.repeat.total}
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-1">
          <CancelButton onCancelled={props.onCancelled} run={props.run} />
        </span>
      </div>

      <div class="space-y-4 px-3 py-3">
        {/* Elapsed against the budget: the focal point */}
        <div>
          <div class="flex flex-wrap items-baseline gap-x-2 font-mono">
            <span
              class={cn(
                'text-[22px] leading-none tabular-nums',
                { over: 'text-error', late: 'text-warning', fine: 'text-foreground' }[pressure()],
              )}
            >
              {elapsed() === undefined ? '–:––' : clock(elapsed()!)}
            </span>
            <span class="text-[11.5px] text-muted-foreground">
              {elapsed() === undefined
                ? `no prompt yet · launched ${when(props.run.launchedAt)}`
                : `of ${props.run.budgetMin}:00`}
            </span>
            <Show when={lastSaid()}>
              {(said) => (
                <span
                  class="ml-auto text-[11px] text-muted-foreground/70"
                  title="The last thing said between Ultimate and the simulated user; work in between does not show here"
                >
                  last said {formatAgo(said().at, now(), { ago: true })}
                </span>
              )}
            </Show>
          </div>
          <div class="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              class={cn(
                'h-full rounded-full transition-[width] duration-1000 ease-linear',
                { over: 'bg-error', late: 'bg-warning', fine: 'bg-brand' }[pressure()],
              )}
              style={{ width: `${share() * 100}%` }}
            />
          </div>
          <Phases phase={props.run.phase} />
        </div>

        {/* Coordinators, landed or working, then anything else busy and cards waiting */}
        <div>
          <h3 class="section-label mb-1">
            coordinators{' '}
            <span class="text-muted-foreground/70">
              {landed()}/{props.run.coordinators.length} landed
            </span>
          </h3>
          <Show when={props.run.coordinators.length > 0} fallback={<Note>none started yet</Note>}>
            <ul class="space-y-0.5 text-[12.5px]">
              <For each={props.run.coordinators} keyed={(c) => c.id}>
                {(c) => {
                  const busy = () => props.run.busy.some((b) => b.id === c().id)
                  return (
                    <li class="flex min-w-0 items-center gap-2">
                      <Show
                        when={c().landed}
                        fallback={
                          <span class="flex size-3 shrink-0 items-center justify-center">
                            <Dot pulse={busy()} tone={busy() ? 'live' : 'cancelled'} />
                          </span>
                        }
                      >
                        <Check class="size-3 shrink-0 text-success" />
                      </Show>
                      <span class="font-mono text-[11px] text-muted-foreground/70">#{c().id}</span>
                      <span class={cn('truncate', !c().landed && !busy() && 'text-muted-foreground')}>
                        {c().intent ?? c().title}
                      </span>
                      <span class="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                        {c().landed ? 'landed' : busy() ? 'working' : 'idle'}
                      </span>
                    </li>
                  )
                }}
              </For>
            </ul>
          </Show>
          <Show when={others().length > 0}>
            <p class="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
              also busy {others().map((b) => `#${b.id} ${b.label ?? b.title ?? ''}`.trim()).join(' · ')}
            </p>
          </Show>
          <Show when={props.run.open > 0}>
            <p class="mt-1.5 font-mono text-[11px] text-warning">
              {plural(props.run.open, 'card')} waiting for the simulated user
            </p>
          </Show>
        </div>

        <Show when={props.run.said.length > 0}>
          <div>
            <h3 class="section-label mb-1">latest</h3>
            <Said said={props.run.said.slice(-4)} />
          </div>
        </Show>
      </div>

      <Show when={props.run.url}>
        {(url) => (
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 px-3 py-2 font-mono text-[11px]">
            <Eye class="size-3 text-muted-foreground" />
            <a
              class="text-foreground/85 underline decoration-border underline-offset-2 hover:decoration-foreground"
              href={url()}
              rel="noreferrer"
              target="_blank"
            >
              {url()}
            </a>
            <span class="rounded-sm bg-warning/15 px-1.5 py-px text-warning">watch only</span>
            <span class="text-muted-foreground/70">anything you click there acts as the user and disturbs the run</span>
          </div>
        )}
      </Show>
    </Box>
  )
}

/** The runner's phases as a quiet trail, the current one lit. */
function Phases(props: { phase: string }) {
  const at = () => PHASES.indexOf(props.phase)
  return (
    <ol class="mt-1.5 flex flex-wrap gap-x-2 font-mono text-[10.5px]">
      <For each={PHASES}>
        {(phase, i) => (
          <li
            class={
              i() === at() ? 'text-brand' : i() < at() ? 'text-muted-foreground' : 'text-muted-foreground/40'
            }
          >
            {phase}
          </li>
        )}
      </For>
    </ol>
  )
}

/** Turns between the simulated user (`you`) and Ultimate, as short lines. */
function Said(props: { said: SaidLine[] }) {
  return (
    <ul class="space-y-1.5">
      <For each={props.said} keyed={false}>
        {(s) => (
          <li class="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2 text-[12.5px]">
            <span class={cn('pt-px font-mono text-[11px]', s().who === 'you' ? 'text-brand' : 'text-muted-foreground')}>
              {s().who === 'you' ? 'sim user' : 'ultimate'}
            </span>
            <span class="line-clamp-3 whitespace-pre-wrap text-foreground/85">{s().text}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

/** Cancel behind a confirmation, which only a person may give: it ends a run Daniel paid for. */
function CancelButton(props: { run: Running; onCancelled: () => void }) {
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const remaining = () => props.run.repeat.total - props.run.repeat.index
  const cancel = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(CancelAction, { id: props.run.id })
      setOpen(false)
      props.onCancelled()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        aria-label={`Cancel run ${props.run.id}…`}
        class="h-6 font-mono text-[11px] text-muted-foreground hover:text-error"
        onClick={() => {
          setError(undefined)
          setOpen(true)
        }}
        size="xs"
        variant="ghost"
      >
        <Square class="size-2.5" />
        cancel
      </Button>
      <Dialog onOpenChange={(next) => !busy() && setOpen(next)} open={open()}>
        <DialogContent class="gap-3 sm:max-w-md">
          <DialogTitle class="text-[15px] font-medium">Cancel this run?</DialogTitle>
          <DialogDescription class="text-[13px] leading-relaxed">
            Run <span class="font-mono text-foreground/85">{props.run.id}</span> stops now and is recorded as
            cancelled, outside the matrix.
            {remaining() > 0 && ` The ${plural(remaining(), 'remaining repeat')} won't start.`} The quota it spent so
            far is not recovered.
          </DialogDescription>
          <Show when={error()}>
            <p class="font-mono text-[11.5px] break-words text-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button
              aria-label={`Keep run ${props.run.id} running`}
              disabled={busy()}
              onClick={() => setOpen(false)}
              size="sm"
              variant="ghost"
            >
              Keep running
            </Button>
            <Button
              aria-label={`Stop run ${props.run.id} now`}
              data-agent-confirm={`Stops eval run ${props.run.id} and the repeats after it; the quota spent is lost.`}
              disabled={busy()}
              onClick={() => cancel()}
              size="sm"
              variant="destructive"
            >
              {busy() ? 'Cancelling…' : 'Cancel run'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
