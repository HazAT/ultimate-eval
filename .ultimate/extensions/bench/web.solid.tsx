/** @jsxImportSource @solidjs/web */
// bench's web facet: the Bench surface. Every run on the left (the one in progress on top), the overview (live run and
// matrix) or one run in full in the middle, and the agent docked on the right to start runs or dig into one.
import { Gauge } from '@lucide/solid'
import { For, Match, Show, Switch, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import {
  Conversation,
  Dock,
  Header,
  StatusLine,
  cn,
  defineWebExtension,
  errorMessage,
  keepLast,
  plural,
  showSurface,
  useAction,
  useExtensionUiState,
  usePageVisible,
  useSurface,
  useViewport,
} from '@/sdk/solid'
import { Detail } from './detail.solid.tsx'
import { Overview } from './overview.solid.tsx'
import { Perf } from './perf.solid.tsx'
import { Dot, Note } from './parts.solid.tsx'
import { LiveAction, OverviewAction, StatusAction, mins, short, toneOf, toneText, usd, verdict, when } from './types.ts'
import type { Summary } from './types.ts'

/** How often the server reads the run in progress while Bench is on screen in a visible tab. */
const LIVE_EVERY = 3000
/** How often it reads whether a run is in progress for the status line, while the tab is visible. */
const STATUS_EVERY = 10_000

function Bench() {
  const visible = usePageVisible()
  const surface = useSurface()
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  // The server polls `live` and pushes only changes; a run leaving it has finished, so the overview loads again.
  const live = useAction(LiveAction, null, {
    every: () => (visible() && surface() === 'bench' ? LIVE_EVERY : undefined),
    onError: keepLast,
  })
  const status = useAction(StatusAction, null, { onError: keepLast })
  const cancelled = () => Promise.all([live.refetch(), status.refetch()])
  const liveIds = createMemo(() => live.data()?.map((r) => r.id).join())
  const overview = useAction(OverviewAction, null, { focus: true, on: liveIds })
  const data = createMemo(() => {
    const loaded = overview.data()
    return loaded && { ...loaded, live: live.data() ?? loaded.live }
  })
  const runs = () => data()?.runs ?? []
  const inProgress = () => data()?.live.length ?? 0
  // A run id, `perf` for the performance trend, or null for the overview.
  const [selected, setSelected] = useExtensionUiState<string | null>('run', null)
  const perf = () => selected() === PERF
  // A run that is gone (or not loaded yet) shows the overview; the stored choice stays for when it comes back.
  const open = () => {
    const id = selected()
    return id !== null && runs().some((r) => r.id === id) ? id : null
  }
  const loadingNote = () => (overview.error() ? errorMessage(overview.error()) : 'loading runs…')
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <Gauge class="size-4 text-muted-foreground" />
          Bench
        </span>
        <Show when={data()}>
          <span class="truncate font-mono text-[11px] text-muted-foreground/70">
            {plural(runs().length, 'run')}
            {inProgress() > 0 && ` · ${inProgress()} in progress`}
          </span>
        </Show>
      </Header>
      <div class="flex min-h-0 flex-1">
        {/* A phone has no run column: the runs follow the matrix there. */}
        <Show when={!phone()}>
          <nav aria-label="Bench runs" class="w-56 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1">
            <Button
              aria-current={open() === null && !perf() ? 'page' : undefined}
              aria-label="Show the overview"
              class={cn(rowClass, 'justify-start gap-2 text-[13px]', open() === null && !perf() && 'bg-accent')}
              onClick={() => setSelected(null)}
              size={null}
              variant={null}
            >
              Overview
              <Show when={inProgress() > 0}>
                <span class="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-brand">
                  <Dot pulse tone="live" />
                  {inProgress() > 1 ? `${inProgress()} live` : 'live'}
                </span>
              </Show>
            </Button>
            <Button
              aria-current={perf() ? 'page' : undefined}
              aria-label="Show the performance trend"
              class={cn(rowClass, 'justify-start gap-2 text-[13px]', perf() && 'bg-accent')}
              onClick={() => setSelected(PERF)}
              size={null}
              variant={null}
            >
              Perf
            </Button>
            <div class="mt-2 px-3 pb-1 section-label">runs</div>
            <Switch>
              <Match when={!data()}>
                <Note class="px-3 py-1">{overview.error() ? errorMessage(overview.error()) : 'loading…'}</Note>
              </Match>
              <Match when={runs().length === 0}>
                <Note class="px-3 py-1">none yet</Note>
              </Match>
            </Switch>
            <For each={runs()} keyed={(r) => r.id}>
              {(r) => <RunRow onClick={() => setSelected(r().id)} run={r()} selected={r().id === open()} />}
            </For>
          </nav>
        </Show>
        <main class="min-w-0 flex-1 overflow-y-auto">
          <Show when={!perf()} fallback={<Perf />}>
          <Show
            when={open()}
            keyed
            fallback={
              <Show
                when={data()}
                fallback={
                  <div class="px-6 py-5">
                    <Note class={cn(overview.error() && 'text-error')}>{loadingNote()}</Note>
                  </div>
                }
              >
                {(loaded) => (
                  <>
                    <Overview data={loaded()} onCancelled={() => void cancelled()} open={setSelected} />
                    <Show when={phone()}>
                      <section class="mx-auto max-w-5xl px-4 pb-6">
                        <h2 class="section-label mb-2">runs</h2>
                        <div class="-mx-3">
                          <For each={runs()} keyed={(r) => r.id}>
                            {(r) => <RunRow onClick={() => setSelected(r().id)} run={r()} selected={false} />}
                          </For>
                        </div>
                      </section>
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            {(id) => <Detail back={() => setSelected(null)} id={id} />}
          </Show>
          </Show>
        </main>
        {/* A phone has no room beside the runs: the agent is a tap away in the title bar there. */}
        <Show when={!phone()}>
          <Dock>
            <Conversation variant="dock" />
          </Dock>
        </Show>
      </div>
      <StatusLine />
    </>
  )
}

/** The stored selection that shows Perf; never a run id. */
const PERF = 'perf'

const rowClass = 'w-full px-3 py-1.5 text-left font-normal hover:bg-accent/60 focus-visible:bg-accent/60'

function RunRow(props: { run: Summary; selected: boolean; onClick: () => void }) {
  const tone = () => toneOf(props.run)
  return (
    <Button
      aria-current={props.selected ? 'page' : undefined}
      aria-label={`Open run ${props.run.id}`}
      class={cn(rowClass, 'flex-col items-stretch gap-0', props.selected && 'bg-accent')}
      onClick={() => props.onClick()}
      size={null}
      variant={null}
    >
      <span class="flex items-center gap-2 font-mono text-[11.5px]">
        <Dot tone={tone()} />
        <span class={toneText[tone()]}>{verdict(props.run)}</span>
        <span class="text-foreground/85">{short(props.run.commit)}</span>
        <span class="ml-auto text-muted-foreground/70">{when(props.run.startedAt)}</span>
      </span>
      <span class="block truncate pl-3.5 font-mono text-[11px] text-muted-foreground/70">
        {props.run.setup} · {mins(props.run.minutes ?? props.run.failure?.atMin)} · {usd(props.run.costUsd)}
      </span>
    </Button>
  )
}

/** `Eval · run 2/4 · running` on the status line while a run is in progress: the A/B plan's place when the script set
 * one, else the repeat's. Opens Bench. */
function EvalChip() {
  const visible = usePageVisible()
  const status = useAction(StatusAction, null, {
    every: () => (visible() ? STATUS_EVERY : undefined),
    onError: keepLast,
  })
  return (
    <Show when={status.data()?.runs[0]}>
      {(run) => {
        const at = () => run().plan ?? run().repeat
        return (
          <StatusButton
            aria-label={`Open Bench: eval run ${run().id} is ${run().phase}`}
            class="min-w-0"
            data-bench-status={run().id}
            onClick={() => showSurface('bench')}
            title={`Eval ${run().scenario} on ${short(run().commit)}${run().plan ? `, repeat ${run().repeat.index}/${run().repeat.total}` : ''}: open Bench`}
          >
            <Dot pulse tone="live" />
            <span class="truncate">
              Eval{at().total > 1 && ` · run ${at().index}/${at().total}`} · {run().phase}
            </span>
          </StatusButton>
        )
      }}
    </Show>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: EvalChip, order: -20, phone: true }] },
  surfaces: [
    {
      id: 'bench',
      title: 'Bench',
      icon: Gauge,
      description: 'The eval run in progress, the pass/N matrix and every run in full',
      component: Bench,
    },
  ],
})
