/** @jsxImportSource @solidjs/web */
// One finished run: its verdict and where it stuck first, then tabs for the scorecard, the simulated user, the
// transcripts, screenshots and the project's test output.
import { ArrowLeft, Check, Sparkles, X } from '@lucide/solid'
import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs.solid.tsx'
import { cn, errorMessage, formatTime, formatTokens, plural, useAction, useExtensionUiState } from '@/sdk/solid'
import { Box, Facts, Note, Section, tabList } from './parts.solid.tsx'
import { Transcripts } from './transcript.solid.tsx'
import { RunAction, ScreenshotAction, mins, pct, short, toneOf, toneText, usd, verdict, when } from './types.ts'
import type { Result, Run, SimCall, Tone } from './types.ts'

const TABS = ['scorecard', 'user', 'transcripts', 'screenshots', 'tests'] as const
type Tab = (typeof TABS)[number]

export function Detail(props: { id: string; back: () => void }) {
  const run = useAction(RunAction, {
    get id() {
      return props.id
    },
  })
  return (
    <div class="mx-auto max-w-5xl px-4 py-4 @container md:px-6">
      <Button
        aria-label="Back to the overview"
        class="mb-3 h-auto gap-1 p-0 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
        onClick={() => props.back()}
        size={null}
        variant={null}
      >
        <ArrowLeft class="size-3" />
        overview
      </Button>
      <Switch fallback={<Note>loading {props.id}…</Note>}>
        <Match when={run.error()}>{(error) => <Note class="text-error">{errorMessage(error())}</Note>}</Match>
        <Match when={run.data()}>{(data) => <Loaded id={props.id} run={data()} />}</Match>
      </Switch>
    </div>
  )
}

function Loaded(props: { id: string; run: Run }) {
  const r = () => props.run.result
  const tone = () => toneOf(r())
  const [stored, setTab] = useExtensionUiState<string>('tab', 'scorecard')
  const tab = () => (TABS.includes(stored() as Tab) ? (stored() as Tab) : 'scorecard')
  const cost = () => (r().scorecard?.usage.totalCostUsd ?? 0) + (r().sim?.costUsd ?? r().simCostUsd ?? 0)
  const tabs = (): { id: Tab; title: string; count?: number }[] => [
    { id: 'scorecard', title: 'scorecard' },
    { id: 'user', title: 'simulated user', count: props.run.sim?.calls.length },
    { id: 'transcripts', title: 'transcripts', count: props.run.transcripts.length },
    { id: 'screenshots', title: 'screenshots', count: props.run.screenshots.length },
    { id: 'tests', title: 'tests' },
  ]
  return (
    <>
      <header>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class={cn('font-mono text-[15px]', toneText[tone()])}>{verdict(r())}</span>
          <h1 class="font-mono text-[13px] text-foreground">{props.id}</h1>
          <span class="font-mono text-[11.5px] text-muted-foreground">
            {short(r().pins.ultimateCommit)} · {r().pins.setup} · {r().pins.scenario}
          </span>
        </div>
        <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
          <span>
            <span class="text-foreground/85">{mins(r().minutes ?? r().failure?.atMin)}</span> of 30
          </span>
          <span>
            <span class="text-foreground/85">{usd(cost())}</span> spent
          </span>
          <Show when={r().scorecard}>
            {(card) => (
              <>
                <span>
                  <span class="text-foreground/85">
                    {card().coordinators.filter((c) => c.landed).length}/{card().coordinators.length}
                  </span>{' '}
                  landed
                </span>
                <span>
                  <span class="text-foreground/85">{pct(card().usage.cacheHitRate)}</span> cache
                </span>
              </>
            )}
          </Show>
          <Show when={(r().sim?.improvised ?? 0) > 0}>
            <span class="text-warning">{r().sim!.improvised} improvised</span>
          </Show>
          <span class="text-muted-foreground/70">started {when(r().startedAt)}</span>
        </div>
      </header>

      <Show when={r().failure}>{(failure) => <FailureBox failure={failure()} tone={tone()} />}</Show>
      <Show when={!r().failure && r().simDone}>
        {(done) => (
          <p class="mt-3 text-[12.5px] text-muted-foreground">
            <span class="font-mono text-[11px] text-muted-foreground/70">sim said done at {mins(done().atMin)} · </span>
            {done().why}
          </p>
        )}
      </Show>

      <Tabs aria-label={`Run ${props.id}`} bind={[tab, setTab]} class="mt-5">
        <div class="mb-4 border-b border-border/70 pb-2">
          <TabsList aria-label={`Views of run ${props.id}`} class={tabList}>
            <For each={tabs()} keyed={(t) => t.id}>
              {(t) => (
                <TabsTab class="rounded-md" value={t().id}>
                  {t().title}
                  <Show when={t().count !== undefined}>
                    <span class="text-muted-foreground/70">{t().count}</span>
                  </Show>
                </TabsTab>
              )}
            </For>
          </TabsList>
        </div>
        <TabsPanel value="scorecard">
          <Scorecard r={r()} />
        </TabsPanel>
        <TabsPanel value="user">
          <SimUser run={props.run} />
        </TabsPanel>
        <TabsPanel value="transcripts">
          <Transcripts id={props.id} run={props.run} />
        </TabsPanel>
        <TabsPanel value="screenshots">
          <Screenshots id={props.id} names={props.run.screenshots} />
        </TabsPanel>
        <TabsPanel value="tests">
          <Tests r={r()} text={props.run.projectTests} />
        </TabsPanel>
      </Tabs>
    </>
  )
}

function FailureBox(props: { failure: NonNullable<Result['failure']>; tone: Tone }) {
  const failed = () => props.tone === 'fail'
  return (
    <Box class={cn('mt-4 space-y-2 px-3 py-2.5', failed() && 'border-error/30 bg-error/5')}>
      <p class="font-mono text-[11.5px]">
        <span class={failed() ? 'text-error' : 'text-muted-foreground'}>{props.failure.reason}</span>
        <Show when={props.failure.atMin !== undefined}>
          <span class="text-muted-foreground"> at {mins(props.failure.atMin)}</span>
        </Show>
        <Show when={props.failure.detail}>
          <span class="text-foreground/85"> · {props.failure.detail}</span>
        </Show>
      </p>
      <Show when={props.failure.stuck}>
        {(stuck) => (
          <div class="space-y-1.5 text-[12.5px]">
            <p class="section-label">
              where it stood
              {stuck().lastProgressMin !== undefined && ` · last progress ${mins(stuck().lastProgressMin)} before`}
            </p>
            <Show when={stuck().busy}>
              {(busy) => (
                <Show when={busy().length > 0} fallback={<Note>nothing busy</Note>}>
                  <p class="font-mono text-[11.5px] text-foreground/85">
                    <span class="text-muted-foreground">busy </span>
                    {busy()
                      .map((b) => `#${b.id} ${b.label ?? ''} ${b.title ?? ''}`.trim())
                      .join(' · ')}
                  </p>
                </Show>
              )}
            </Show>
            <For each={stuck().open ?? []}>
              {(card) => (
                <p class="text-foreground/85">
                  <span class="font-mono text-[11px] text-warning">
                    open card {card.id}
                    {card.from !== undefined && ` from #${card.from}`}{' '}
                  </span>
                  {card.text}
                </p>
              )}
            </For>
            <Show when={stuck().lastSaid}>
              {(said) => (
                <p class="line-clamp-3 text-foreground/80">
                  <span class="font-mono text-[11px] text-muted-foreground">
                    last said by {said().who === 'you' ? 'sim user' : 'ultimate'}{' '}
                  </span>
                  {said().text}
                </p>
              )}
            </Show>
          </div>
        )}
      </Show>
    </Box>
  )
}

/** A check mark, a cross, or blank room when it was not decided. */
function Pass(props: { ok: boolean | undefined }) {
  return (
    <Switch fallback={<span class="inline-block size-3 shrink-0" />}>
      <Match when={props.ok === true}>
        <Check class="size-3 shrink-0 text-success" />
      </Match>
      <Match when={props.ok === false}>
        <X class="size-3 shrink-0 text-error" />
      </Match>
    </Switch>
  )
}

type Card = NonNullable<Result['scorecard']>

function Scorecard(props: { r: Result }) {
  return (
    <div class="grid gap-x-8 gap-y-6 @3xl:grid-cols-2">
      <div class="min-w-0 space-y-6">
        <Acceptance r={props.r} />
        <Show when={props.r.scorecard}>
          {(card) => (
            <>
              <Checks card={card()} />
              <Coordinators card={card()} />
              <ToolErrors card={card()} />
              <Questions card={card()} />
            </>
          )}
        </Show>
      </div>
      <div class="min-w-0 space-y-6">
        <Show when={props.r.scorecard}>{(card) => <UsageByModel card={card()} r={props.r} />}</Show>
        <ModelsByRole r={props.r} />
        <Section title="pins">
          <Facts
            rows={[
              ['ultimate', short(props.r.pins.ultimateCommit)],
              ['scenario', `${props.r.pins.scenario}@${props.r.pins.scenarioSha.slice(0, 6)}`],
              ['setup', `${props.r.pins.setup}${props.r.pins.setupSha ? `@${props.r.pins.setupSha.slice(0, 6)}` : ''}`],
              ['sim', `${props.r.pins.simModel ?? '–'} · ${props.r.pins.simEffort ?? ''}`],
              ['sim prompt', props.r.pins.simPromptSha ?? '–'],
              ['eval', short(props.r.pins.evalCommit)],
              ['startup', props.r.startupSec !== undefined ? `${props.r.startupSec}s` : '–'],
            ]}
          />
        </Section>
        <Show when={props.r.mainLog?.length}>
          <Section title="main after the run">
            <ul class="space-y-0.5 font-mono text-[11px]">
              <For each={props.r.mainLog}>
                {(line) => (
                  <li class="truncate text-foreground/80">
                    <span class="text-muted-foreground/70">{line.slice(0, 7)}</span>
                    {line.slice(7)}
                  </li>
                )}
              </For>
            </ul>
          </Section>
        </Show>
      </div>
    </div>
  )
}

function Acceptance(props: { r: Result }) {
  return (
    <Section title="acceptance">
      <Show when={props.r.acceptance?.length} fallback={<Note>Not run: the run ended before acceptance.</Note>}>
        <ul class="space-y-0.5 text-[12.5px]">
          <For each={props.r.acceptance}>
            {(a) => (
              <li class="flex min-w-0 items-start gap-2">
                <span class="pt-1">
                  <Pass ok={a.pass} />
                </span>
                <span class="min-w-0">
                  <span class={cn(!a.pass && 'text-error')}>{a.name}</span>
                  <Show when={a.detail}>
                    <span class="block truncate font-mono text-[10.5px] text-muted-foreground/70">{a.detail}</span>
                  </Show>
                </span>
              </li>
            )}
          </For>
          <li class="flex items-center gap-2">
            <Pass ok={props.r.projectTests?.pass} />
            <span class={cn(props.r.projectTests?.pass === false && 'text-error')}>project tests</span>
          </li>
          <li class="flex items-center gap-2">
            <Pass ok={props.r.noRemote} />
            <span>no remote, nothing pushed</span>
          </li>
        </ul>
      </Show>
    </Section>
  )
}

function Checks(props: { card: Card }) {
  const found = () => (props.card.checks ?? []).filter((c) => c.gate === 'finding' && !c.pass).length
  return (
    <Show when={props.card.checks?.length}>
      <Section aside={found() ? plural(found(), 'finding') : 'no findings'} title="checks">
        <ul class="space-y-0.5 text-[12.5px]">
          <For each={props.card.checks}>
            {(c) => (
              <li class="flex min-w-0 items-start gap-2">
                <span class="pt-1">
                  <Show when={c.pass || c.gate === 'pass'} fallback={<Sparkles class="size-3 shrink-0 text-warning" />}>
                    <Pass ok={c.pass} />
                  </Show>
                </span>
                <span class="min-w-0">
                  <span class={cn(!c.pass && (c.gate === 'pass' ? 'text-error' : 'text-warning'))}>{c.name}</span>
                  <span class="ml-2 font-mono text-[10.5px] text-muted-foreground/70">
                    {c.gate === 'pass' ? 'required' : 'finding'}
                  </span>
                  <Show when={c.detail}>
                    <span class="block truncate font-mono text-[10.5px] text-muted-foreground/70" title={c.detail}>
                      {c.detail}
                    </span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Section>
    </Show>
  )
}

function Coordinators(props: { card: Card }) {
  const c = () => props.card
  return (
    <Section
      aside={`${plural(c().landings.count, 'landing')} · first ${mins(c().timing.firstLandingMin)} · last ${mins(c().timing.lastLandingMin)}`}
      title="coordinators"
    >
      <ul class="space-y-0.5 text-[12.5px]">
        <For each={c().coordinators}>
          {(coordinator) => (
            <li class="flex min-w-0 items-center gap-2">
              <Pass ok={coordinator.landed} />
              <span class="font-mono text-[11px] text-muted-foreground/70">#{coordinator.id}</span>
              <span class="truncate">{coordinator.intent ?? coordinator.title}</span>
              <span class="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                {coordinator.features.join(', ')}
                {(c().workers.byCoordinator[coordinator.id] ?? 0) > 0 &&
                  ` · ${c().workers.byCoordinator[coordinator.id]} workers`}
              </span>
            </li>
          )}
        </For>
      </ul>
      <p class="mt-1.5 font-mono text-[11px] text-muted-foreground/70">
        {c().workers.total} workers · {c().plans.coordinatorsWithPlan} with a plan · {c().plans.tasks} tasks ·{' '}
        {c().toolErrors} tool errors · {c().watchdog.failures} watchdog
      </p>
    </Section>
  )
}

function ToolErrors(props: { card: Card }) {
  return (
    <Show when={props.card.toolErrorDetail}>
      {(detail) => (
        <Section
          aside={`benign: ${
            Object.entries(detail().benign)
              .map(([kind, n]) => `${n} ${kind}`)
              .join(', ') || 'none'
          }`}
          title={`tool errors ${props.card.toolErrors}`}
        >
          <Show when={detail().list.length > 0} fallback={<Note>none beyond the benign ones</Note>}>
            <ul class="space-y-1.5 text-[12.5px]">
              <For each={detail().list}>
                {(e) => (
                  <li class="min-w-0">
                    <span class="block font-mono text-[10.5px] text-muted-foreground/70">
                      #{e.conversation} · entry {e.entry} · {e.tool} ·{' '}
                      <span class={cn(e.category !== 'bashExit' && 'text-warning')}>{e.category}</span>
                    </span>
                    <span class="line-clamp-2 font-mono text-[11px] text-foreground/80">{e.text}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Section>
      )}
    </Show>
  )
}

function Questions(props: { card: Card }) {
  const q = () => props.card.questions
  return (
    <Show when={q().asked > 0}>
      <Section
        aside={`${q().answered}/${q().asked} answered${
          q().multi ? ` · multi ${q().multiAnswered ?? '?'}/${q().multi} answered` : ''
        }`}
        title="questions asked"
      >
        <ul class="space-y-2">
          <For each={q().texts}>
            {(text, i) => (
              <li class="text-[12.5px]">
                <span class="block font-mono text-[10.5px] text-muted-foreground/70">
                  card {text.id} · from #{text.from} · {text.kinds.join(', ') || 'text'}
                  {q().waitSec[i()] !== undefined && ` · waited ${q().waitSec[i()]}s`}
                </span>
                <span class="line-clamp-4 text-foreground/85">{text.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Section>
    </Show>
  )
}

function UsageByModel(props: { card: Card; r: Result }) {
  return (
    <Section aside={`cache ${pct(props.card.usage.cacheHitRate)}`} title="usage">
      <ul class="space-y-1.5 font-mono text-[11.5px]">
        <For each={Object.entries(props.card.usage.byModel)}>
          {([model, u]) => (
            <li class="min-w-0">
              <span class="flex gap-2">
                <span class="truncate text-foreground/85" title={model}>
                  {model}
                </span>
                <span class="ml-auto shrink-0 text-foreground/85">{usd(u.costUsd)}</span>
              </span>
              <span class="block text-[11px] text-muted-foreground/70">
                {u.calls} calls · {formatTokens(u.input)} in · {formatTokens(u.output)} out · cache{' '}
                {formatTokens(u.cacheRead)} read, {formatTokens(u.cacheWrite)} written
              </span>
            </li>
          )}
        </For>
        <Show when={props.r.sim}>
          {(sim) => (
            <li class="min-w-0">
              <span class="flex gap-2">
                <span class="truncate text-muted-foreground">simulated user</span>
                <span class="ml-auto shrink-0 text-foreground/85">{usd(sim().costUsd)}</span>
              </span>
              <span class="block text-[11px] text-muted-foreground/70">
                {sim().calls} calls · {sim().nudges} nudges · {sim().refusedAnswers} refused answers
              </span>
            </li>
          )}
        </Show>
      </ul>
    </Section>
  )
}

/** The per-role table: the model each role was pinned to, and whether the run's agent profile matched it. */
function ModelsByRole(props: { r: Result }) {
  const rows = createMemo(() =>
    Object.entries(props.r.pins.roles ?? {}).map(([role, pin]) => {
      const family = typeof pin === 'string' ? pin : pin.family
      const codeMode = typeof pin === 'object' && pin.codeMode === true
      const m = props.r.models?.[role]
      // Results before the agent-profile check wrote `ok`; later ones write `status`.
      const status = m?.status ?? (m?.ok === true ? 'ok' : m?.ok === false ? 'mismatch' : undefined)
      return { role, family, codeMode, pinned: props.r.pins.families?.[family], status, ran: m?.ran ?? [] }
    }),
  )
  return (
    <Show when={rows().length > 0}>
      <Section title="models by role">
        <ul class="space-y-1 font-mono text-[11.5px]">
          <For each={rows()}>
            {(row) => (
              <li class="grid min-w-0 grid-cols-[0.75rem_6rem_minmax(0,1fr)] gap-x-2">
                <span class="pt-1">
                  <Pass ok={row.status === 'ok' ? true : row.status === 'mismatch' ? false : undefined} />
                </span>
                <span class="text-muted-foreground">{row.role}</span>
                <span class="min-w-0">
                  <span class="block truncate text-foreground/85" title={row.pinned?.model}>
                    {row.pinned?.model ?? row.family}
                  </span>
                  <span class="block text-[11px] text-muted-foreground/70">
                    {row.family}
                    {row.pinned?.thinking && ` · ${row.pinned.thinking}`}
                    {row.codeMode && ' · code mode'}
                    {row.status && row.status !== 'ok' && row.status !== 'mismatch' && ` · ${row.status}`}
                  </span>
                  <Show when={row.status === 'mismatch'}>
                    <span class="block text-[11px] text-error">ran {row.ran.join(', ')}</span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Section>
    </Show>
  )
}

/** Every turn of the simulated user: what it decided and why, improvised ones flagged, Ultimate's lines between. */
function SimUser(props: { run: Run }) {
  const calls = () => props.run.sim?.calls ?? []
  const first = () => calls()[0]?.at ?? 0
  // Ultimate's side from `said`; the sim's own lines are its decisions already.
  const rows = createMemo(() =>
    [
      ...calls().map((call) => ({ at: call.at, call, text: undefined })),
      ...(props.run.sim?.said ?? [])
        .filter((s) => s.who === 'ultimate')
        .map((s) => ({ at: s.at, call: undefined, text: s.text })),
    ].toSorted((a, b) => a.at - b.at),
  )
  const improvised = () => calls().filter((c) => c.decision?.improvised).length
  return (
    <Show when={calls().length > 0} fallback={<Note>No simulated-user turns recorded.</Note>}>
      <p class="mb-3 font-mono text-[11px] text-muted-foreground/70">
        {calls().length} turns · {usd(calls().reduce((sum, c) => sum + (c.costUsd ?? 0), 0))}
        <Show when={improvised() > 0}>
          <span class="text-warning"> · {improvised()} improvised</span>
        </Show>{' '}
        · Ultimate's lines in grey
      </p>
      <ol class="space-y-1">
        <For each={rows()}>
          {(row) => (
            <Show
              when={row.call}
              fallback={
                <li class="grid grid-cols-[3.5rem_4.5rem_minmax(0,1fr)] gap-x-2 px-2 py-1 text-[12.5px]">
                  <span class="pt-px font-mono text-[11px] text-muted-foreground/50">{offset(row.at, first())}</span>
                  <span class="pt-px font-mono text-[11px] text-muted-foreground/70">ultimate</span>
                  <span class="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{row.text}</span>
                </li>
              }
            >
              {(call) => <SimTurn call={call()} first={first()} />}
            </Show>
          )}
        </For>
      </ol>
    </Show>
  )
}

const offset = (at: number, first: number) => `+${((at - first) / 60_000).toFixed(1)}m`

function SimTurn(props: { call: SimCall; first: number }) {
  const d = () => props.call.decision
  const text = () => {
    const decision = d()
    if (decision?.action === 'message') return decision.text
    if (decision?.action !== 'answer') return undefined
    return [
      ...(decision.answers ?? []).map(
        (a) => `${a.question}: ${Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}`,
      ),
      ...(decision.note ? [`Note: ${decision.note}`] : []),
    ].join('\n')
  }
  const actionTone = () => {
    if (props.call.error) return 'text-error'
    const action = d()?.action
    if (!action || action === 'wait') return 'text-muted-foreground/70'
    return action === 'done' ? 'text-success' : 'text-brand'
  }
  return (
    <li
      class={cn(
        'grid grid-cols-[3.5rem_4.5rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-1 text-[12.5px]',
        d()?.improvised && 'bg-warning/5',
      )}
    >
      <span class="pt-px font-mono text-[11px] text-muted-foreground/70" title={formatTime(props.call.at, true)}>
        {offset(props.call.at, props.first)}
      </span>
      <span class={cn('pt-px font-mono text-[11px]', actionTone())}>
        {props.call.error ? 'error' : (d()?.action ?? '–')}
        {d()?.action === 'answer' && d()?.messageId !== undefined && ` ${d()!.messageId}`}
      </span>
      <span class="min-w-0">
        <Show when={text()}>
          <span class="block whitespace-pre-wrap text-foreground/90">{text()}</span>
        </Show>
        <Show when={d()?.why || props.call.error}>
          <span
            class={cn(
              'block text-muted-foreground',
              text() && 'text-[11.5px]',
              props.call.error && 'text-error',
            )}
          >
            <Show when={d()?.improvised}>
              <span class="mr-1.5 inline-flex items-center gap-1 font-mono text-[10.5px] text-warning">
                <Sparkles class="size-2.5" />
                improvised
              </span>
            </Show>
            {props.call.error ?? d()?.why}
          </span>
        </Show>
        <span class="block font-mono text-[10px] text-muted-foreground/50">
          {props.call.ms !== undefined && `${(props.call.ms / 1000).toFixed(1)}s`}
          {props.call.costUsd !== undefined && ` · ${usd(props.call.costUsd)}`}
        </span>
      </span>
    </li>
  )
}

function Screenshots(props: { id: string; names: string[] }) {
  const [big, setBig] = createSignal<string>()
  return (
    <Show when={props.names.length > 0} fallback={<Note>No screenshots: acceptance did not run.</Note>}>
      <div class="grid gap-4 sm:grid-cols-2">
        <For each={props.names}>
          {(name) => (
            <Shot
              big={big() === name}
              id={props.id}
              name={name}
              toggle={() => setBig((current) => (current === name ? undefined : name))}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

function Shot(props: { id: string; name: string; big: boolean; toggle: () => void }) {
  const src = useAction(ScreenshotAction, {
    get id() {
      return props.id
    },
    get name() {
      return props.name
    },
  })
  const title = () => props.name.replace(/\.png$/, '')
  return (
    <figure class={cn('min-w-0', props.big && 'sm:col-span-2')}>
      <figcaption class="mb-1 font-mono text-[11px] text-muted-foreground">{title()}</figcaption>
      <Button
        aria-label={`${props.big ? 'Shrink' : 'Enlarge'} screenshot ${title()}`}
        class="block h-auto w-full cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/30 p-0 font-normal focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => props.toggle()}
        size={null}
        variant={null}
      >
        <Show
          when={src.data()}
          fallback={
            <span class="block aspect-[16/10] p-3 text-left">
              <Note>{src.error() ? errorMessage(src.error()) : 'loading…'}</Note>
            </span>
          }
        >
          {(data) => <img alt={title()} class="block w-full" src={data()} />}
        </Show>
      </Button>
    </figure>
  )
}

function Tests(props: { r: Result; text?: string }) {
  const tests = () => props.r.projectTests
  return (
    <>
      <p class="mb-2 font-mono text-[11.5px]">
        <span class={tests()?.pass ? 'text-success' : tests() ? 'text-error' : 'text-muted-foreground'}>
          {tests() ? (tests()!.pass ? 'project tests pass' : 'project tests fail') : 'not run'}
        </span>
        <Show when={tests()?.detail}>
          <span class="text-muted-foreground"> · {tests()!.detail}</span>
        </Show>
      </p>
      <Show when={props.text} fallback={<Note>No test output.</Note>}>
        <pre class="overflow-x-auto rounded-md bg-terminal px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          {props.text}
        </pre>
      </Show>
    </>
  )
}
