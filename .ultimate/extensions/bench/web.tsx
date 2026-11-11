// bench's web facet: the Bench surface. Every run on the left (the one in progress on top), the overview (live run and
// matrix) or one run in full in the middle, and the agent docked on the right to start runs or dig into one.
import { GaugeIcon } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import {
  Conversation,
  Dock,
  Header,
  StatusLine,
  cn,
  defineWebExtension,
  errorMessage,
  useAction,
  useExtensionUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import { Detail } from './detail.tsx'
import { Overview } from './overview.tsx'
import { Dot, Note } from './parts.tsx'
import { LiveAction, OverviewAction, mins, short, toneOf, toneText, usd, verdict, when } from './types.ts'
import type { Summary } from './types.ts'

/** How often the run in progress is read while the surface is on screen. */
const POLL = 3000

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/** Whether Bench is on screen in a visible tab: polling runs only then. */
function useShown() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  return useUltimate().surface === 'bench' && visible
}

function Bench() {
  const shown = useShown()
  const viewport = useViewport()
  const overview = useAction(OverviewAction, null, { focus: true })
  const live = useAction(LiveAction, null, { every: POLL, enabled: shown })
  const [selected, setSelected] = useExtensionUiState<string | null>('run', null)
  // The poll is fresher than the overview; a run that left it has finished, so the overview loads again.
  const inProgress = live.data ?? overview.data?.live ?? []
  const liveIds = live.data?.map((r) => r.id).join()
  const { refetch } = overview
  useEffect(() => {
    if (liveIds !== undefined) void refetch()
  }, [liveIds, refetch])
  const data = overview.data && { ...overview.data, live: inProgress }
  const runs = data?.runs ?? []
  const open = runs.some((r) => r.id === selected) ? selected : null
  return (
    <>
      <Header>
        <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <GaugeIcon className="size-4 text-muted-foreground" />
          Bench
        </span>
        {data && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/70">
            {runs.length} run{runs.length === 1 ? '' : 's'}
            {inProgress.length > 0 && ` · ${inProgress.length} in progress`}
          </span>
        )}
      </Header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1 md:block">
          <button
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] outline-none hover:bg-accent/60 focus-visible:bg-accent/60',
              open === null && 'bg-accent',
            )}
            data-selected={open === null || undefined}
            onClick={() => setSelected(null)}
            type="button"
          >
            Overview
            {inProgress.length > 0 && (
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-brand">
                <Dot pulse tone="live" />
                {inProgress.length > 1 ? `${inProgress.length} live` : 'live'}
              </span>
            )}
          </button>
          <div className="mt-2 px-3 pb-1 section-label">runs</div>
          {!data && <Note className="px-3 py-1">{overview.error ? errorMessage(overview.error) : 'loading…'}</Note>}
          {data && runs.length === 0 && <Note className="px-3 py-1">none yet</Note>}
          {runs.map((r) => (
            <RunRow key={r.id} onClick={() => setSelected(r.id)} run={r} selected={r.id === open} />
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          {open ? (
            <Detail back={() => setSelected(null)} id={open} key={open} />
          ) : data ? (
            <>
              <Overview data={data} open={setSelected} refetch={() => void live.refetch()} />
              {/* Narrow screens have no run column: the runs follow the matrix. */}
              <section className="mx-auto max-w-5xl px-4 pb-6 md:hidden">
                <h2 className="section-label mb-2">runs</h2>
                <div className="-mx-3">
                  {runs.map((r) => (
                    <RunRow key={r.id} onClick={() => setSelected(r.id)} run={r} selected={false} />
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="px-6 py-5">
              <Note className={overview.error && 'text-error'}>
                {overview.error ? errorMessage(overview.error) : 'loading runs…'}
              </Note>
            </div>
          )}
        </main>
        {/* A phone has no room beside the runs: the agent is a tap away in the title bar there. */}
        {viewport !== 'phone' && (
          <Dock>
            <Conversation variant="dock" />
          </Dock>
        )}
      </div>
      <StatusLine />
    </>
  )
}

function RunRow({ run: r, selected, onClick }: { run: Summary; selected: boolean; onClick: () => void }) {
  const tone = toneOf(r)
  return (
    <button
      className={cn(
        'block w-full cursor-pointer px-3 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent/60',
        selected && 'bg-accent',
      )}
      data-selected={selected || undefined}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-2 font-mono text-[11.5px]">
        <Dot tone={tone} />
        <span className={toneText[tone]}>{verdict(r)}</span>
        <span className="text-foreground/85">{short(r.commit)}</span>
        <span className="ml-auto text-muted-foreground/70">{when(r.startedAt)}</span>
      </span>
      <span className="block truncate pl-3.5 font-mono text-[11px] text-muted-foreground/70">
        {r.setup} · {mins(r.minutes ?? r.failure?.atMin)} · {usd(r.costUsd)}
      </span>
    </button>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'bench',
      title: 'Bench',
      icon: GaugeIcon,
      description: 'The eval run in progress, the pass/N matrix and every run in full',
      component: Bench,
    },
  ],
})
