/** @jsxImportSource @solidjs/web */
// The overview: the run in progress, then the matrix (commit × setup × scenario × eval harness), each row's runs a click away.
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { CancelDialog, LiveRuns } from './live.solid.tsx'
import { Box, Dot, Note, Section } from './parts.solid.tsx'
import { mins, short, toneOf, toneText, usd, verdict } from './types.ts'
import type { Group, Overview as Data, Running, Summary } from './types.ts'

export function Overview(props: { data: Data; open: (id: string) => void; onCancelled: () => void }) {
  const byId = createMemo(() => new Map(props.data.runs.map((r) => [r.id, r])))
  const cancelled = () => props.data.runs.filter((r) => r.status === 'cancelled').length
  const [cancelling, setCancelling] = createSignal<Running>()
  return (
    <div class="mx-auto max-w-5xl space-y-6 px-4 py-5 md:px-6">
      <CancelDialog onCancelled={props.onCancelled} onClose={() => setCancelling()} run={cancelling()} />
      <Section title="now">
        <Show
          when={props.data.live.length > 0}
          fallback={
            <Box class="px-3 py-2.5">
              <Note>No run in progress. Ask the agent to start one, such as “run the eval on main, 3 repeats”.</Note>
            </Box>
          }
        >
          <LiveRuns live={props.data.live} onCancel={(run) => setCancelling(run)} />
        </Show>
      </Section>

      <Section aside={cancelled() > 0 ? `${cancelled()} cancelled left out` : undefined} title="matrix">
        <Show when={props.data.matrix.length > 0} fallback={<Note>No finished runs yet.</Note>}>
          <Box>
            <ul class="divide-y divide-border/50">
              <For each={props.data.matrix} keyed={(g) => g.ids.join()}>
                {(g) => <Row byId={byId()} group={g()} open={props.open} />}
              </For>
            </ul>
          </Box>
        </Show>
      </Section>
    </div>
  )
}

/** One group: pass/N first, what it pinned, its medians; then the features and each run, failures saying why. */
function Row(props: { group: Group; byId: Map<string, Summary>; open: (id: string) => void }) {
  const rate = () => (props.group.n ? props.group.passes / props.group.n : 0)
  // The group counts only passing features; its runs name the ones that never passed too.
  const features = createMemo(() => {
    const names = new Set(Object.keys(props.group.features))
    for (const id of props.group.ids) for (const f of Object.keys(props.byId.get(id)?.features ?? {})) names.add(f)
    return [...names].map((name) => ({ name, count: props.group.features[name] ?? 0 }))
  })
  const g = () => props.group
  return (
    <li class="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-3 py-2.5 font-mono text-[11.5px]">
      <span
        class={cn(
          'row-span-2 text-[15px] leading-tight tabular-nums',
          rate() === 1 ? 'text-success' : rate() === 0 ? 'text-error' : 'text-warning',
        )}
        title={`${g().passes} of ${g().n} runs passed`}
      >
        {g().passes}/{g().n}
      </span>
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span class="truncate">
          <span class="text-foreground">{short(g().commit)}</span>
          <span class="text-muted-foreground">
            {' '}
            · {g().setup} · {g().scenario}
            <span class="text-muted-foreground/60">@{g().scenarioSha.slice(0, 6)}</span>
            <span class="text-muted-foreground/60" title="The eval harness commit these runs were made with">
              {' '}
              · eval {short(g().evalCommit) || '-'}
            </span>
          </span>
        </span>
        <span class="ml-auto shrink-0 text-muted-foreground">
          median <span class="text-foreground/85">{mins(g().medianMin)}</span> ·{' '}
          <span class="text-foreground/85">{usd(g().medianCost)}</span>
        </span>
      </span>
      <span class="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <For each={features()} keyed={(f) => f.name}>
          {(f) => (
            <span
              class={f().count === g().n ? 'text-muted-foreground/70' : 'text-warning'}
              title={`${f().name}: ${f().count} of ${g().n} runs pass it`}
            >
              {f().name} {f().count}/{g().n}
            </span>
          )}
        </For>
        <span
          class="text-muted-foreground/70"
          title={`a multi-choice card was asked in ${g().multi.asked} and answered in ${g().multi.answered} of ${g().n} runs`}
        >
          multi asked {g().multi.asked}/{g().n}
          {g().multi.answered !== g().multi.asked && ` · answered ${g().multi.answered}/${g().n}`}
        </span>
        <span class="ml-auto flex flex-wrap gap-1">
          <For each={g().ids}>{(id) => <RunChip id={id} open={props.open} run={props.byId.get(id)} />}</For>
        </span>
      </span>
    </li>
  )
}

/** One run of a group: its last four characters, and for a failure its verdict and when it stuck. */
function RunChip(props: { id: string; run: Summary | undefined; open: (id: string) => void }) {
  const tone = () => (props.run ? toneOf(props.run) : 'cancelled')
  return (
    <Button
      aria-label={`Open run ${props.id} from the matrix`}
      class="h-5 gap-1 rounded-sm px-1 font-normal text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => props.open(props.id)}
      size={null}
      title={
        props.run
          ? `${props.id} · ${verdict(props.run)} · ${mins(props.run.minutes ?? props.run.failure?.atMin)} · ${usd(props.run.costUsd)}`
          : props.id
      }
      variant={null}
    >
      <Dot tone={tone()} />
      {props.id.slice(-4)}
      <Show when={props.run && !props.run.pass ? props.run : undefined}>
        {(r) => (
          <span class={toneText[tone()]}>
            {verdict(r())}
            {r().failure?.atMin !== undefined && ` ${Math.round(r().failure!.atMin!)}m`}
          </span>
        )}
      </Show>
    </Button>
  )
}
