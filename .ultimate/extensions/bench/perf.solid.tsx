/** @jsxImportSource @solidjs/web */
// Perf: the black-box performance trend from `pnpm eval perf`. One small chart per headline metric (median of the
// repeats with a min–max band), every batch × Ultimate commit a column, eval versions side by side and never joined;
// a column opens that point's passes in full.
import { ArrowLeft, ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Match, Show, Switch, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.solid.tsx'
import { cn, errorMessage, formatBytes, useAction, useExtensionUiState } from '@/sdk/solid'
import { Box, Note, Section } from './parts.solid.tsx'
import { PerfAction, PerfPointAction, short } from './types.ts'
import type { PerfPoint, Stat, TrendPass, TrendPoint, TrendVersion } from './types.ts'

/** The charts, in the order a person reads a session: open, switch, reply, stream, then the rest. */
const HEADLINE: { group: string; metrics: [key: string, label: string][] }[] = [
  { group: 'load', metrics: [['firstLoad.cold.transcriptMs', 'cold load → transcript'], ['firstLoad.warm.transcriptMs', 'warm load → transcript']] },
  { group: 'switch', metrics: [
    ['switch.cold.visibleMs', 'cold switch · visible'], ['switch.warm.visibleMs', 'warm switch · visible'],
    ['switch.cold.settledMs', 'cold switch · settled'], ['switch.warm.settledMs', 'warm switch · settled'],
  ] },
  { group: 'reply', metrics: [['ttft.totalMs', 'time to first token'], ['ttft.serverPrepMs', 'server prep'], ['sendToResponse.userMs', 'send → own message']] },
  { group: 'streaming', metrics: [
    ['streaming.progress.p95LagMs', 'stream lag p95'], ['streaming.progress.maxGapMs', 'stream max gap'],
    ['streaming.frames.longAnimationFrame.totalMs', 'long frames while streaming'],
  ] },
  { group: 'and', metrics: [
    ['memory.jsHeapUsedMB', 'JS heap'], ['reconnect.outageMs', 'reconnect outage'],
    ['keypress.duration.medianMs', 'keypress median'], ['keypress.duration.p95Ms', 'keypress p95'],
  ] },
]

const CHARTED = HEADLINE.flatMap((g) => g.metrics.map(([key]) => key))

/** A column of the charts: one point, and where its version starts. */
type Column = { point: TrendPoint; version: TrendVersion; versionIndex: number; first: boolean }
const columnId = (p: TrendPoint) => `${p.batch}:${p.commit}`

const day = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const dateOf = (p: TrendPoint) => (p.date ? day.format(new Date(p.date)) : '?')

/** A value in the unit its key names: MB, bytes, counts, else milliseconds (seconds from 10 s). */
export function fmt(key: string, value: number | null | undefined) {
  if (value === null || value === undefined) return '–'
  if (key.endsWith('MB')) return `${value.toFixed(1)} MB`
  if (key.endsWith('Bytes')) return formatBytes(value)
  if (key.startsWith('load1')) return value.toFixed(2)
  if (/(count|Count|nodes|Listeners|Over33Ms)$/.test(key)) return String(Math.round(value))
  if (key === 'cpuBusy') return `${Math.round(value * 100)}%`
  if (key.endsWith('Sec')) return `${value.toFixed(1)} s`
  return Math.abs(value) >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
}

/** `back` is given on a phone, which has no run column to leave by. */
export function Perf(props: { back?: () => void }) {
  const trend = useAction(PerfAction, { metrics: CHARTED }, { focus: true })
  return (
    <div class="mx-auto max-w-5xl px-4 py-5 @container md:px-6">
      <Show when={props.back}>
        {(back) => (
          <Button
            aria-label="Back to the overview"
            class="mb-3 h-auto gap-1 p-0 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
            onClick={() => back()()}
            size={null}
            variant={null}
          >
            <ArrowLeft class="size-3" />
            overview
          </Button>
        )}
      </Show>
      <Switch fallback={<Note>loading performance batches…</Note>}>
        <Match when={trend.error()}>{(error) => <Note class="text-error">{errorMessage(error())}</Note>}</Match>
        <Match when={trend.data()?.length === 0}>
          <Note>No performance batches yet. `pnpm eval perf` writes runs/perf-*.json; exports live in results/perf/.</Note>
        </Match>
        <Match when={trend.data()}>{(versions) => <Loaded versions={versions()} />}</Match>
      </Switch>
    </div>
  )
}

function Loaded(props: { versions: TrendVersion[] }) {
  const columns = createMemo(() =>
    props.versions.flatMap((version, versionIndex) =>
      version.points.map((point, i): Column => ({ point, version, versionIndex, first: i === 0 })),
    ),
  )
  const [stored, setStored] = useExtensionUiState<string | null>('perfPoint', null)
  let detail: HTMLDivElement | undefined
  // Picking a point brings its passes into view: they sit below every chart.
  const setSelected = (id: string) => {
    setStored(id)
    requestAnimationFrame(() => detail?.scrollIntoView({ block: 'start' }))
  }
  // The newest point until one is picked; a stored one that is gone falls back to it too.
  const selected = createMemo(() => {
    const all = columns()
    return all.find((c) => columnId(c.point) === stored()) ?? all.at(-1)
  })
  const batches = () => new Set(columns().map((c) => c.point.batch)).size
  return (
    <div class="space-y-6">
      <Section
        aside={`${batches()} ${batches() === 1 ? 'batch' : 'batches'} · ${props.versions.length} eval ${props.versions.length === 1 ? 'version' : 'versions'}`}
        title="perf trend"
      >
        <Note class="mb-3">
          Median of the repeats, band from min to max. Lines never join different eval versions (a change to the measuring
          code); <span class="text-warning">×</span> is a point where every pass failed that measurement.
        </Note>
        <Points columns={columns()} select={setSelected} selected={selected()} />
      </Section>
      <For each={HEADLINE}>
        {(group) => (
          <section>
            <h2 class="section-label mb-2">{group.group === 'and' ? 'memory · reconnect · keypress' : group.group}</h2>
            <div class="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
              <For each={group.metrics}>
                {([key, label]) => (
                  <Chart columns={columns()} label={label} metric={key} select={setSelected} selected={selected()} />
                )}
              </For>
            </div>
          </section>
        )}
      </For>
      <div class="scroll-mt-4" ref={detail}>
        <Show when={selected()} keyed>
          {(column) => <PointDetail column={column} />}
        </Show>
      </div>
    </div>
  )
}

/** The columns as named buttons, grouped by eval version: the legend of every chart and how to pick a point. */
function Points(props: { columns: Column[]; selected: Column | undefined; select: (id: string) => void }) {
  const versions = createMemo(() => {
    const groups: Column[][] = []
    for (const c of props.columns) (groups[c.versionIndex] ??= []).push(c)
    return groups
  })
  return (
    <div class="flex flex-wrap gap-x-5 gap-y-2">
      <For each={versions()}>
        {(group) => (
          <div class="min-w-0">
            <p class="mb-1 font-mono text-[11px] text-muted-foreground/70" title={group[0]!.version.evalCommits.join('\n')}>
              eval {group[0]!.version.evalCommits.map(short).join(', ')}
              {group[0]!.version.evalDiff && ` + dirty ${group[0]!.version.evalDiff.slice(0, 6)}`}
              {group[0]!.version.small && ' · small'}
            </p>
            <div class="flex flex-wrap gap-1">
              <For each={group}>
                {(c) => {
                  const on = () => props.selected === c
                  return (
                    <Button
                      aria-current={on() ? 'true' : undefined}
                      aria-label={`Show perf point ${props.columns.indexOf(c) + 1}: ${short(c.point.commit)} from ${c.point.batch}`}
                      class={cn(
                        'h-auto flex-col items-start gap-0 rounded-md border border-border/70 px-2 py-1 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                        on() && 'border-foreground/30 bg-accent text-foreground',
                      )}
                      onClick={() => props.select(columnId(c.point))}
                      size={null}
                      title={`${c.point.commit}\n${c.point.batch} (${c.point.source}) · n=${c.point.n}`}
                      variant={null}
                    >
                      <span class="text-foreground/85">{short(c.point.commit)}</span>
                      <span class="text-muted-foreground/70">
                        {dateOf(c.point)}
                        {c.point.batch.startsWith('nightly') ? ' · nightly' : ''}
                      </span>
                    </Button>
                  )
                }}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

const W = 300
const H = 84
const PAD = 10

/** One metric across every column: band and median per run of measured points in one version, × where none were. */
function Chart(props: { metric: string; label: string; columns: Column[]; selected: Column | undefined; select: (id: string) => void }) {
  const stats = createMemo(() => props.columns.map((c) => c.point.metrics[props.metric]))
  const top = createMemo(() => Math.max(0, ...stats().map((s) => s?.max ?? 0)) * 1.1 || 1)
  const x = (i: number) => (props.columns.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (props.columns.length - 1))
  const y = (v: number) => H - 4 - ((H - 12) * v) / top()
  /** Runs of consecutive measured columns within one version: what one line and one band may span. */
  const segments = createMemo(() => {
    const out: number[][] = []
    let run: number[] = []
    props.columns.forEach((c, i) => {
      const measured = stats()[i]?.median != null
      if (!measured || c.first) {
        if (run.length) out.push(run)
        run = []
      }
      if (measured) run.push(i)
    })
    if (run.length) out.push(run)
    return out
  })
  const at = createMemo(() => {
    const i = props.selected ? props.columns.indexOf(props.selected) : -1
    return i < 0 ? undefined : { i, stat: stats()[i] }
  })
  const pick = (event: MouseEvent) => {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect()
    const px = ((event.clientX - box.left) / box.width) * W
    let best = 0
    props.columns.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
    })
    const column = props.columns[best]
    if (column) props.select(columnId(column.point))
  }
  return (
    <Box class="px-3 pt-2 pb-1.5">
      <div class="flex items-baseline gap-2 font-mono text-[11px]">
        <span class="truncate text-muted-foreground" title={props.metric}>
          {props.label}
        </span>
        <span class="ml-auto shrink-0 tabular-nums">
          <StatText metric={props.metric} stat={at()?.stat} />
        </span>
      </div>
      {/* The column buttons above are the named way to pick a point; a click here is the same, by position. */}
      <svg
        aria-hidden="true"
        class="mt-1 block h-[84px] w-full overflow-visible"
        onClick={pick}
        preserveAspectRatio="none"
        viewBox={`0 0 ${W} ${H}`}
      >
        <line class="stroke-border" vector-effect="non-scaling-stroke" x1="0" x2={W} y1={H - 4} y2={H - 4} />
        <For each={props.columns}>
          {(c, i) => (
            <Show when={c.first && i() > 0}>
              <line
                class="stroke-muted-foreground/40"
                stroke-dasharray="3 3"
                vector-effect="non-scaling-stroke"
                x1={(x(i()) + x(i() - 1)) / 2}
                x2={(x(i()) + x(i() - 1)) / 2}
                y1="0"
                y2={H}
              />
            </Show>
          )}
        </For>
        <Show when={at()}>
          {(sel) => (
            <line class="stroke-foreground/25" vector-effect="non-scaling-stroke" x1={x(sel().i)} x2={x(sel().i)} y1="0" y2={H - 4} />
          )}
        </Show>
        <For each={segments()}>
          {(run) => (
            <>
              <Show
                when={run.length > 1}
                fallback={
                  <line
                    class="stroke-brand/25"
                    stroke-width="6"
                    vector-effect="non-scaling-stroke"
                    x1={x(run[0]!)}
                    x2={x(run[0]!)}
                    y1={y(stats()[run[0]!]!.min!)}
                    y2={y(stats()[run[0]!]!.max!)}
                  />
                }
              >
                <polygon
                  class="fill-brand/15"
                  points={[
                    ...run.map((i) => `${x(i)},${y(stats()[i]!.max!)}`),
                    ...run.toReversed().map((i) => `${x(i)},${y(stats()[i]!.min!)}`),
                  ].join(' ')}
                />
                <polyline
                  class="fill-none stroke-brand"
                  points={run.map((i) => `${x(i)},${y(stats()[i]!.median!)}`).join(' ')}
                  stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                />
              </Show>
            </>
          )}
        </For>
        <For each={props.columns}>
          {(c, i) => {
            const s = () => stats()[i()]
            return (
              <Show
                when={s()?.median != null}
                fallback={
                  <Show when={s() && s()!.failed > 0 && s()!.failed === c.point.n}>
                    <g class="stroke-warning" stroke-width="1.5">
                      <title>{`${short(c.point.commit)}: no value, ${s()!.failed} of ${c.point.n} failed`}</title>
                      <line vector-effect="non-scaling-stroke" x1={x(i()) - 3} x2={x(i()) + 3} y1={H - 10} y2={H - 4} />
                      <line vector-effect="non-scaling-stroke" x1={x(i()) - 3} x2={x(i()) + 3} y1={H - 4} y2={H - 10} />
                    </g>
                  </Show>
                }
              >
                {/* A zero-length line with round caps is a dot that the aspect ratio does not stretch. */}
                <line
                  class={props.selected === c ? 'stroke-foreground' : 'stroke-brand'}
                  stroke-linecap="round"
                  stroke-width={props.selected === c ? 7 : 5}
                  vector-effect="non-scaling-stroke"
                  x1={x(i())}
                  x2={x(i())}
                  y1={y(s()!.median!)}
                  y2={y(s()!.median!)}
                >
                  <title>{`${short(c.point.commit)} ${dateOf(c.point)}: ${fmt(props.metric, s()!.median)} (${fmt(props.metric, s()!.min)}–${fmt(props.metric, s()!.max)}, n=${s()!.n})`}</title>
                </line>
              </Show>
            )
          }}
        </For>
      </svg>
      <div class="relative mt-0.5 h-3.5 font-mono text-[10px] text-muted-foreground/60">
        <For each={props.columns}>
          {(c, i) => (
            <Show
              when={
                (props.columns.length <= 8 || c.first || i() === props.columns.length - 1) &&
                (i() === 0 || dateOf(props.columns[i() - 1]!.point) !== dateOf(c.point))
              }
            >
              <span class="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(x(i()) / W) * 100}%` }}>
                {dateOf(c.point)}
              </span>
            </Show>
          )}
        </For>
      </div>
    </Box>
  )
}

function StatText(props: { metric: string; stat: Stat | undefined }) {
  return (
    <Switch fallback={<span class="text-muted-foreground/60">–</span>}>
      <Match when={props.stat?.median != null && props.stat}>
        {(s) => (
          <>
            <span class="text-foreground/90">{fmt(props.metric, s().median)}</span>
            <span class="text-muted-foreground/60">
              {' '}
              {fmt(props.metric, s().min)}–{fmt(props.metric, s().max)}
            </span>
          </>
        )}
      </Match>
      <Match when={props.stat && props.stat.failed > 0}>
        <span class="text-warning">no value · {props.stat!.failed} failed</span>
      </Match>
    </Switch>
  )
}

/** One point's passes in full: the machine, every measurement per repeat, the switches and the streaming curve. */
function PointDetail(props: { column: Column }) {
  const point = useAction(PerfPointAction, {
    get batch() {
      return props.column.point.batch
    },
    get commit() {
      return props.column.point.commit
    },
  })
  return (
    <Section
      aside={`${props.column.point.batch} · ${props.column.point.source === 'export' ? 'exported' : 'local'} · eval ${short(props.column.point.evalCommit)}`}
      title={`${short(props.column.point.commit)} · ${dateOf(props.column.point)} · ${props.column.point.n} ${props.column.point.n === 1 ? 'pass' : 'passes'}`}
    >
      <Switch fallback={<Note>loading…</Note>}>
        <Match when={point.error()}>{(error) => <Note class="text-error">{errorMessage(error())}</Note>}</Match>
        <Match when={point.data()}>{(data) => <Passes point={data()} />}</Match>
      </Switch>
    </Section>
  )
}

const ROWS: { title: string; rows: [key: string, label: string][] }[] = [
  { title: 'machine', rows: [['load1Start', 'load1 start'], ['load1End', 'load1 end'], ['cpuBusy', 'cpu busy'], ['waitedSec', 'waited for load']] },
  { title: 'load', rows: [
    ['firstBuildMs', 'first build'],
    ['firstLoad.cold.transcriptMs', 'cold · transcript'], ['firstLoad.cold.fcpMs', 'cold · first paint'], ['firstLoad.cold.dclMs', 'cold · DOM ready'],
    ['firstLoad.cold.transferBytes', 'cold · transferred'],
    ['firstLoad.warm.transcriptMs', 'warm · transcript'], ['firstLoad.warm.fcpMs', 'warm · first paint'], ['firstLoad.warm.dclMs', 'warm · DOM ready'],
    ['firstLoad.warm.transferBytes', 'warm · transferred'],
  ] },
  { title: 'switch (median of the pass)', rows: [
    ['switch.cold.visibleMs', 'cold · visible'], ['switch.cold.settledMs', 'cold · settled'], ['switch.cold.freshViewMs', 'cold · fresh view'], ['switch.cold.longMs', 'cold · long tasks'],
    ['switch.warm.visibleMs', 'warm · visible'], ['switch.warm.settledMs', 'warm · settled'], ['switch.warm.freshViewMs', 'warm · fresh view'], ['switch.warm.longMs', 'warm · long tasks'],
  ] },
  { title: 'reply', rows: [
    ['sendToResponse.userMs', 'send → own message'], ['sendToResponse.answerMs', 'send → answer'],
    ['ttft.totalMs', 'first token · total'], ['ttft.serverPrepMs', 'first token · server'], ['ttft.streamToVisibleMs', 'first token · stream → visible'],
    ['ttft.lastChunkMs', 'last chunk'], ['ttft.lastChunkToVisibleMs', 'last chunk → visible'],
  ] },
  { title: 'streaming', rows: [
    ['streaming.progress.visibleCount', 'markers seen (of 16)'], ['streaming.progress.firstProgressMs', 'first progress'],
    ['streaming.progress.p95LagMs', 'lag p95'], ['streaming.progress.p95GapMs', 'gap p95'], ['streaming.progress.maxGapMs', 'max gap'],
    ['streaming.frames.longAnimationFrame.totalMs', 'long frames · total'], ['streaming.frames.longAnimationFrame.count', 'long frames · count'],
    ['streaming.frames.longtask.totalMs', 'long tasks · total'], ['streaming.frames.rafGapsOver33Ms', 'frames over 33 ms'],
  ] },
  { title: 'memory', rows: [['memory.jsHeapUsedMB', 'JS heap'], ['memory.nodes', 'DOM nodes'], ['memory.jsEventListeners', 'listeners']] },
  { title: 'reconnect', rows: [
    ['reconnect.outageMs', 'outage'], ['reconnect.readyToViewMs', 'ready → view'], ['reconnect.handshakeMs', 'handshake'], ['reconnect.restartBuildMs', 'restart build'],
  ] },
  { title: 'keypress', rows: [['keypress.duration.medianMs', 'median'], ['keypress.duration.p95Ms', 'p95'], ['keypress.count', 'keys'], ['keypress.eventTimingCount', 'event timings']] },
]

/** The failure covering `key` in a pass, if any: its own error or a parent measurement's. */
const failure = (pass: TrendPass, key: string) => {
  if (pass.error !== undefined) return pass.error
  const path = Object.keys(pass.errors).find((p) => key === p || key.startsWith(`${p}.`))
  return path === undefined ? undefined : (pass.errors[path] ?? `${path} failed`)
}
/** The pass's own readings (machine load), recorded even when its measurements failed. */
const MACHINE = new Set(['load1Start', 'load1End', 'cpuBusy', 'waitedSec'])
const value = (pass: TrendPass, key: string): number | null | undefined =>
  MACHINE.has(key) ? (pass as unknown as Record<string, number | null>)[key] : pass.metrics[key]
/** What a cell shows in place of a value: the failure that covers it, unless it holds a number anyway. */
const cellError = (pass: TrendPass, key: string) =>
  MACHINE.has(key) || typeof pass.metrics[key] === 'number' ? undefined : failure(pass, key)

function Passes(props: { point: PerfPoint }) {
  const passes = () => props.point.passes.toSorted((a, b) => a.repeat - b.repeat)
  const cols = () => `12rem repeat(${passes().length}, 5.5rem)`
  return (
    <div class="space-y-5">
      <div class="grid gap-x-8 gap-y-5 @5xl:grid-cols-2">
        <For each={ROWS}>
          {(block) => (
            <div class="min-w-0 overflow-x-auto">
              <p class="section-label mb-1">{block.title}</p>
              <div class="grid w-max gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]" style={{ 'grid-template-columns': cols() }}>
                <span />
                <For each={passes()}>{(p) => <span class="text-right text-muted-foreground/60">#{p.repeat}</span>}</For>
                <For each={block.rows}>
                  {([key, label]) => (
                    <>
                      <span class="truncate text-muted-foreground/70" title={key}>
                        {label}
                      </span>
                      <For each={passes()}>
                        {(p) => (
                          <Cell error={cellError(p, key)}>
                            {fmt(key, value(p, key))}
                            <Show when={key === 'waitedSec' && p.gate === 'timeout'}>
                              <span class="text-warning"> gate timed out</span>
                            </Show>
                          </Cell>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
      <StreamCurve passes={passes()} />
      <Show when={passes().some((p) => p.switches)}>
        <Switches passes={passes()} />
      </Show>
      <Rest cols={cols()} passes={passes()} />
    </div>
  )
}

const SHOWN = new Set(ROWS.flatMap((b) => b.rows.map(([key]) => key)))

/** Every other recorded metric (the stream's per-line lag is in its curve; its sent and visible times are here), folded away. */
function Rest(props: { passes: TrendPass[]; cols: string }) {
  const keys = createMemo(() =>
    // A failed measurement's own path is left out when the rows above already show it failed.
    [...new Set(props.passes.flatMap((p) => [...Object.keys(p.metrics), ...Object.keys(p.errors)]))]
      .filter((key) => !SHOWN.has(key) && !/^streaming\.line\d+\.lagMs$/.test(key) && ![...SHOWN].some((s) => s.startsWith(`${key}.`)))
      .toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  )
  return (
    <Show when={keys().length > 0}>
      <Collapsible aria-label="Every other metric of this point">
        <CollapsibleTrigger class="group/rest flex items-center gap-1 font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronRight aria-hidden="true" class="size-3 transition-transform group-data-open/rest:rotate-90" />
          {keys().length} more recorded {keys().length === 1 ? 'metric' : 'metrics'}
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-2 overflow-x-auto">
          <div
            class="grid w-max gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]"
            style={{ 'grid-template-columns': props.cols.replace('12rem', '22rem') }}
          >
            <span />
            <For each={props.passes}>{(p) => <span class="text-right text-muted-foreground/60">#{p.repeat}</span>}</For>
            <For each={keys()}>
              {(key) => (
                <>
                  <span class="truncate text-muted-foreground/70" title={key}>
                    {key}
                  </span>
                  <For each={props.passes}>
                    {(p) => <Cell error={cellError(p, key)}>{fmt(key, value(p, key))}</Cell>}
                  </For>
                </>
              )}
            </For>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Show>
  )
}

/** A value, or the failure in its place (the message on hover). */
function Cell(props: { error: string | undefined; children: JSX.Element }) {
  return (
    <Show when={props.error} fallback={<span class="text-right text-foreground/85 tabular-nums">{props.children}</span>}>
      <span class="truncate text-right text-warning" title={props.error}>
        failed
      </span>
    </Show>
  )
}

const LINES = Array.from({ length: 16 }, (_, i) => (i + 1) * 100)

/** The 16 streaming markers: how far behind the model each became visible, one line per pass. */
function StreamCurve(props: { passes: TrendPass[] }) {
  const lag = (p: TrendPass, line: number) => p.metrics[`streaming.line${line}.lagMs`] ?? null
  const top = createMemo(() => Math.max(1, ...props.passes.flatMap((p) => LINES.map((l) => lag(p, l) ?? 0))) * 1.1)
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (LINES.length - 1)
  const y = (v: number) => H - 4 - ((H - 12) * v) / top()
  const tones = ['stroke-brand', 'stroke-foreground/60', 'stroke-muted-foreground/60', 'stroke-warning/70']
  return (
    <div>
      <div class="mb-1 flex items-baseline gap-3">
        <p class="section-label">streaming curve · lag behind the model at lines 100–1600</p>
        <span class="ml-auto flex gap-3 font-mono text-[11px] text-muted-foreground/70">
          <For each={props.passes}>
            {(p, i) => (
              <span class="flex items-center gap-1">
                <svg aria-hidden="true" class="h-2 w-3" viewBox="0 0 12 8">
                  <line class={tones[i() % tones.length]} stroke-width="2" x1="0" x2="12" y1="4" y2="4" />
                </svg>
                #{p.repeat}
              </span>
            )}
          </For>
          <span>top {fmt('ms', top() / 1.1)}</span>
        </span>
      </div>
      <Box class="px-3 py-2">
        <svg aria-hidden="true" class="block h-[84px] w-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${W} ${H}`}>
          <line class="stroke-border" vector-effect="non-scaling-stroke" x1="0" x2={W} y1={H - 4} y2={H - 4} />
          <For each={props.passes}>
            {(p, i) => (
              <polyline
                class={cn('fill-none', tones[i() % tones.length])}
                points={LINES.flatMap((l, j) => (lag(p, l) === null ? [] : [`${x(j)},${y(lag(p, l)!)}`])).join(' ')}
                stroke-width="1.25"
                vector-effect="non-scaling-stroke"
              />
            )}
          </For>
        </svg>
        <div class="relative mt-0.5 h-3.5 font-mono text-[10px] text-muted-foreground/60">
          <For each={[0, 3, 7, 11, 15]}>
            {(j) => (
              <span class="absolute -translate-x-1/2" style={{ left: `${(x(j) / W) * 100}%` }}>
                {LINES[j]}
              </span>
            )}
          </For>
        </div>
      </Box>
      <div
        class="mt-2 grid gap-x-1 gap-y-[2px] overflow-x-auto font-mono text-[10.5px] tabular-nums"
        style={{ 'grid-template-columns': '2rem repeat(16, minmax(2.1rem, 1fr))' }}
      >
        <span class="text-muted-foreground/60">line</span>
        <For each={LINES}>{(l) => <span class="text-right text-muted-foreground/60">{l}</span>}</For>
        <For each={props.passes}>
          {(p) => (
            <>
              <span class="text-muted-foreground/60">#{p.repeat}</span>
              <For each={LINES}>
                {(l) => (
                  <span class={cn('text-right', lag(p, l) === null ? 'text-warning' : 'text-foreground/80')}>
                    {lag(p, l) === null ? '–' : Math.round(lag(p, l)!)}
                  </span>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  )
}

/** Every switch of a local record (an export keeps only the medians above): three targets, a cold round, two warm. */
function Switches(props: { passes: TrendPass[] }) {
  const rows = () =>
    props.passes.flatMap((p) =>
      p.switches ? [...p.switches.cold, ...p.switches.warm].map((s) => ({ repeat: p.repeat, ...s })) : [],
    )
  return (
    <div>
      <p class="section-label mb-1">every switch</p>
      <div class="grid grid-cols-[3rem_3rem_4rem_repeat(4,minmax(4rem,1fr))] gap-x-3 gap-y-[2px] font-mono text-[11px] tabular-nums">
        <For each={['pass', 'round', 'to', 'fresh view', 'visible', 'settled', 'long tasks']}>
          {(h, i) => <span class={cn('text-muted-foreground/60', i() > 2 && 'text-right')}>{h}</span>}
        </For>
        <For each={rows()}>
          {(s) => (
            <>
              <span class="text-muted-foreground/70">#{s.repeat}</span>
              <span class="text-muted-foreground/70">{s.round === 0 ? 'cold' : `warm ${s.round}`}</span>
              <span class="text-muted-foreground/70">#{s.id}</span>
              <span class="text-right text-foreground/80">{fmt('ms', s.freshViewMs)}</span>
              <span class="text-right text-foreground/85">{fmt('ms', s.visibleMs)}</span>
              <span class="text-right text-foreground/85">{fmt('ms', s.settledMs)}</span>
              <span class="text-right text-foreground/80">{fmt('ms', s.longMs)}</span>
            </>
          )}
        </For>
      </div>
    </div>
  )
}
