// One finished run: its verdict and where it stuck first, then tabs for the scorecard, the simulated user, the
// transcripts, screenshots and the project's test output.
import { ArrowLeftIcon, CheckIcon, SparklesIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { cn, errorMessage, formatTime, formatTokens, useAction, useExtensionUiState } from '@/sdk'
import { Box, Facts, Note, Section, Tabs } from './parts.tsx'
import { Transcripts } from './transcript.tsx'
import { RunAction, ScreenshotAction, mins, pct, short, toneOf, toneText, usd, verdict, when } from './types.ts'
import type { Result, Run, SimCall, Stuck } from './types.ts'

const TABS = ['scorecard', 'user', 'transcripts', 'screenshots', 'tests'] as const
type Tab = (typeof TABS)[number]

export function Detail({ id, back }: { id: string; back: () => void }) {
  const run = useAction(RunAction, { id })
  const [stored, setTab] = useExtensionUiState('tab', 'scorecard')
  const tab = (TABS.includes(stored as Tab) ? stored : 'scorecard') as Tab
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 @container md:px-6">
      <button
        className="mb-3 flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        onClick={back}
        type="button"
      >
        <ArrowLeftIcon className="size-3" />
        overview
      </button>
      {run.error ? (
        <Note className="text-error">{errorMessage(run.error)}</Note>
      ) : !run.data ? (
        <Note>loading {id}…</Note>
      ) : (
        <Loaded id={id} run={run.data} setTab={setTab} tab={tab} />
      )}
    </div>
  )
}

function Loaded({ id, run, tab, setTab }: { id: string; run: Run; tab: Tab; setTab: (t: Tab) => void }) {
  const r = run.result
  const tone = toneOf(r)
  const cost = (r.scorecard?.usage.totalCostUsd ?? 0) + (r.sim?.costUsd ?? r.simCostUsd ?? 0)
  const improvised = r.sim?.improvised ?? 0
  const tabs: { id: Tab; title: string; count?: number | string }[] = [
    { id: 'scorecard', title: 'scorecard' },
    { id: 'user', title: 'simulated user', count: run.sim?.calls.length },
    { id: 'transcripts', title: 'transcripts', count: run.transcripts.length },
    { id: 'screenshots', title: 'screenshots', count: run.screenshots.length },
    { id: 'tests', title: 'tests' },
  ]
  return (
    <>
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={cn('font-mono text-[15px]', toneText[tone])}>{verdict(r)}</span>
          <h1 className="font-mono text-[13px] text-foreground">{id}</h1>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {short(r.pins.ultimateCommit)} · {r.pins.setup} · {r.pins.scenario}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
          <span>
            <span className="text-foreground/85">{mins(r.minutes ?? r.failure?.atMin)}</span> of 30
          </span>
          <span>
            <span className="text-foreground/85">{usd(cost)}</span> spent
          </span>
          {r.scorecard && (
            <>
              <span>
                <span className="text-foreground/85">
                  {r.scorecard.coordinators.filter((c) => c.landed).length}/
                  {r.scorecard.coordinators.length}
                </span>{' '}
                landed
              </span>
              <span>
                <span className="text-foreground/85">{pct(r.scorecard.usage.cacheHitRate)}</span> cache
              </span>
            </>
          )}
          {improvised > 0 && (
            <span className="text-warning">{improvised} improvised</span>
          )}
          <span className="text-muted-foreground/70">started {when(r.startedAt)}</span>
        </div>
      </header>

      {r.failure && <FailureBox failure={r.failure} tone={tone} />}
      {r.simDone && !r.failure && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          <span className="font-mono text-[11px] text-muted-foreground/70">
            sim said done at {mins(r.simDone.atMin)} ·{' '}
          </span>
          {r.simDone.why}
        </p>
      )}

      <div className="mt-5 mb-4 border-b border-border/70 pb-2">
        <Tabs onChange={setTab} tabs={tabs} value={tab} />
      </div>
      {tab === 'scorecard' && <Scorecard r={r} />}
      {tab === 'user' && <SimUser run={run} />}
      {tab === 'transcripts' && <Transcripts id={id} run={run} />}
      {tab === 'screenshots' && <Screenshots id={id} names={run.screenshots} />}
      {tab === 'tests' && <Tests r={r} text={run.projectTests} />}
    </>
  )
}

function FailureBox({ failure, tone }: { failure: NonNullable<Result['failure']>; tone: string }) {
  const stuck = failure.stuck as Stuck | null | undefined
  return (
    <Box
      className={cn(
        'mt-4 space-y-2 px-3 py-2.5',
        tone === 'fail' && 'border-error/30 bg-error/5',
      )}
    >
      <p className="font-mono text-[11.5px]">
        <span className={tone === 'fail' ? 'text-error' : 'text-muted-foreground'}>{failure.reason}</span>
        {failure.atMin !== undefined && (
          <span className="text-muted-foreground"> at {mins(failure.atMin)}</span>
        )}
        {failure.detail && <span className="text-foreground/85"> · {failure.detail}</span>}
      </p>
      {stuck && (
        <div className="space-y-1.5 text-[12.5px]">
          <p className="section-label">
            where it stood
            {stuck.lastProgressMin !== undefined &&
              ` · last progress ${mins(stuck.lastProgressMin)} before`}
          </p>
          {stuck.busy && stuck.busy.length > 0 && (
            <p className="font-mono text-[11.5px] text-foreground/85">
              <span className="text-muted-foreground">busy </span>
              {stuck.busy.map((b) => `#${b.id} ${b.label ?? ''} ${b.title ?? ''}`.trim()).join(' · ')}
            </p>
          )}
          {stuck.busy?.length === 0 && <Note>nothing busy</Note>}
          {stuck.open?.map((o) => (
            <p className="text-foreground/85" key={o.id}>
              <span className="font-mono text-[11px] text-warning">
                open card {o.id}
                {o.from !== undefined && ` from #${o.from}`}{' '}
              </span>
              {o.text}
            </p>
          ))}
          {stuck.lastSaid && (
            <p className="line-clamp-3 text-foreground/80">
              <span className="font-mono text-[11px] text-muted-foreground">
                last said by {stuck.lastSaid.who === 'you' ? 'sim user' : 'ultimate'}{' '}
              </span>
              {stuck.lastSaid.text}
            </p>
          )}
        </div>
      )}
    </Box>
  )
}

function Pass({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <span className="inline-block size-3 shrink-0" />
  return ok ? (
    <CheckIcon className="size-3 shrink-0 text-success" />
  ) : (
    <XIcon className="size-3 shrink-0 text-error" />
  )
}

function Scorecard({ r }: { r: Result }) {
  const card = r.scorecard
  return (
    <div className="grid gap-x-8 gap-y-6 @3xl:grid-cols-2">
      <div className="min-w-0 space-y-6">
        <Section title="acceptance">
          {r.acceptance?.length ? (
            <ul className="space-y-0.5 text-[12.5px]">
              {r.acceptance.map((a) => (
                <li className="flex min-w-0 items-start gap-2" key={a.name}>
                  <span className="pt-1"><Pass ok={a.pass} /></span>
                  <span className="min-w-0">
                    <span className={cn(!a.pass && 'text-error')}>{a.name}</span>
                    {a.detail && (
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground/70">
                        {a.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
              <li className="flex items-center gap-2">
                <Pass ok={r.projectTests?.pass} />
                <span className={cn(r.projectTests?.pass === false && 'text-error')}>project tests</span>
              </li>
              <li className="flex items-center gap-2">
                <Pass ok={r.noRemote} />
                <span>no remote, nothing pushed</span>
              </li>
            </ul>
          ) : (
            <Note>Not run: the run ended before acceptance.</Note>
          )}
        </Section>

        {card && (
          <Section
            aside={`${card.landings.count} landing${card.landings.count === 1 ? '' : 's'} · first ${mins(card.timing.firstLandingMin)} · last ${mins(card.timing.lastLandingMin)}`}
            title="coordinators"
          >
            <ul className="space-y-0.5 text-[12.5px]">
              {card.coordinators.map((c) => (
                <li className="flex min-w-0 items-center gap-2" key={c.id}>
                  <Pass ok={c.landed} />
                  <span className="font-mono text-[11px] text-muted-foreground/70">#{c.id}</span>
                  <span className="truncate">{c.intent ?? c.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                    {c.features.join(', ')}
                    {(card.workers.byCoordinator[c.id] ?? 0) > 0 &&
                      ` · ${card.workers.byCoordinator[c.id]} workers`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/70">
              {card.workers.total} workers · {card.plans.coordinatorsWithPlan} with a plan ·{' '}
              {card.plans.tasks} tasks · {card.toolErrors} tool errors · {card.watchdog.failures} watchdog
            </p>
          </Section>
        )}

        {card && card.questions.asked > 0 && (
          <Section
            aside={`${card.questions.answered}/${card.questions.asked} answered`}
            title="questions asked"
          >
            <ul className="space-y-2">
              {card.questions.texts.map((q, i) => (
                <li className="text-[12.5px]" key={q.id}>
                  <span className="block font-mono text-[10.5px] text-muted-foreground/70">
                    card {q.id} · from #{q.from} · {q.kinds.join(', ') || 'text'}
                    {card.questions.waitSec[i] !== undefined &&
                      ` · waited ${card.questions.waitSec[i]}s`}
                  </span>
                  <span className="line-clamp-4 text-foreground/85">{q.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <div className="min-w-0 space-y-6">
        {card && (
          <Section aside={`cache ${pct(card.usage.cacheHitRate)}`} title="usage">
            <ul className="space-y-1.5 font-mono text-[11.5px]">
              {Object.entries(card.usage.byModel).map(([model, u]) => (
                <li className="min-w-0" key={model}>
                  <span className="flex gap-2">
                    <span className="truncate text-foreground/85" title={model}>
                      {model}
                    </span>
                    <span className="ml-auto shrink-0 text-foreground/85">{usd(u.costUsd)}</span>
                  </span>
                  <span className="block text-[11px] text-muted-foreground/70">
                    {u.calls} calls · {formatTokens(u.input)} in · {formatTokens(u.output)} out ·
                    cache {formatTokens(u.cacheRead)} read, {formatTokens(u.cacheWrite)} written
                  </span>
                </li>
              ))}
              {r.sim && (
                <li className="min-w-0">
                  <span className="flex gap-2">
                    <span className="truncate text-muted-foreground">simulated user</span>
                    <span className="ml-auto shrink-0 text-foreground/85">{usd(r.sim.costUsd)}</span>
                  </span>
                  <span className="block text-[11px] text-muted-foreground/70">
                    {r.sim.calls} calls · {r.sim.nudges} nudges · {r.sim.refusedAnswers} refused answers
                  </span>
                </li>
              )}
            </ul>
          </Section>
        )}

        {r.pins.roles && (
          <Section title="models by role">
            <ul className="space-y-1 font-mono text-[11.5px]">
              {Object.entries(r.pins.roles).map(([role, family]) => {
                const f = r.pins.families?.[family]
                const m = r.models?.[role]
                return (
                  <li className="grid min-w-0 grid-cols-[0.75rem_6rem_minmax(0,1fr)] gap-x-2" key={role}>
                    <span className="pt-1">
                      <Pass ok={m?.ok} />
                    </span>
                    <span className="text-muted-foreground">{role}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-foreground/85" title={f?.model}>
                        {f?.model ?? family}
                      </span>
                      <span className="block text-[11px] text-muted-foreground/70">
                        {family}
                        {f?.thinking && ` · ${f.thinking}`}
                        {m && m.ok === undefined && ' · not exercised'}
                      </span>
                      {m?.ok === false && (
                        <span className="block text-[11px] text-error">ran {m.ran.join(', ')}</span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </Section>
        )}

        <Section title="pins">
          <Facts
            rows={[
              ['ultimate', short(r.pins.ultimateCommit)],
              ['scenario', `${r.pins.scenario}@${r.pins.scenarioSha.slice(0, 6)}`],
              ['setup', `${r.pins.setup}${r.pins.setupSha ? `@${r.pins.setupSha.slice(0, 6)}` : ''}`],
              ['sim', `${r.pins.simModel ?? '–'} · ${r.pins.simEffort ?? ''}`],
              ['sim prompt', r.pins.simPromptSha ?? '–'],
              ['eval', short(r.pins.evalCommit)],
              ['startup', r.startupSec !== undefined ? `${r.startupSec}s` : '–'],
            ]}
          />
        </Section>

        {r.mainLog && r.mainLog.length > 0 && (
          <Section title="main after the run">
            <ul className="space-y-0.5 font-mono text-[11px]">
              {r.mainLog.map((line) => (
                <li className="truncate text-foreground/80" key={line}>
                  <span className="text-muted-foreground/70">{line.slice(0, 7)}</span>
                  {line.slice(7)}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}

/** Every turn of the simulated user: what it decided and why, improvised ones flagged. */
function SimUser({ run }: { run: Run }) {
  const calls = run.sim?.calls ?? []
  if (calls.length === 0) return <Note>No simulated-user turns recorded.</Note>
  const first = calls[0]!.at
  // Ultimate's side from `said`, between the decisions it led to; the sim's own lines are its decisions already.
  const heard = (run.sim?.said ?? []).filter((s) => s.who === 'ultimate')
  const rows = [
    ...calls.map((call) => ({ at: call.at, call })),
    ...heard.map((said) => ({ at: said.at, said })),
  ].sort((a, b) => a.at - b.at)
  const improvised = calls.filter((c) => c.decision?.improvised).length
  return (
    <>
      <p className="mb-3 font-mono text-[11px] text-muted-foreground/70">
        {calls.length} turns · {usd(calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0))}
        {improvised > 0 && <span className="text-warning"> · {improvised} improvised</span>} ·
        Ultimate's lines in grey
      </p>
      <ol className="space-y-1">
        {rows.map((row, i) =>
          'call' in row ? (
            <SimTurn call={row.call} first={first} key={i} />
          ) : (
            <li
              className="grid grid-cols-[3.5rem_4.5rem_minmax(0,1fr)] gap-x-2 px-2 py-1 text-[12.5px]"
              key={i}
            >
              <span className="pt-px font-mono text-[11px] text-muted-foreground/50">
                +{((row.at - first) / 60_000).toFixed(1)}m
              </span>
              <span className="pt-px font-mono text-[11px] text-muted-foreground/70">ultimate</span>
              <span className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">
                {row.said.text}
              </span>
            </li>
          ),
        )}
      </ol>
    </>
  )
}

function SimTurn({ call: c, first }: { call: SimCall; first: number }) {
  const d = c.decision
  const quiet = !d || d.action === 'wait'
  const text =
    d?.action === 'message'
      ? d.text
      : d?.action === 'answer'
        ? [
            ...(d.answers ?? []).map(
              (a) => `${a.question}: ${Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}`,
            ),
            ...(d.note ? [`Note: ${d.note}`] : []),
          ].join('\n')
        : undefined
  return (
    <li
      className={cn(
        'grid grid-cols-[3.5rem_4.5rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-1 text-[12.5px]',
        d?.improvised && 'bg-warning/5',
      )}
    >
      <span className="pt-px font-mono text-[11px] text-muted-foreground/70" title={formatTime(c.at, true)}>
        +{((c.at - first) / 60_000).toFixed(1)}m
      </span>
      <span
        className={cn(
          'pt-px font-mono text-[11px]',
          c.error ? 'text-error' : quiet ? 'text-muted-foreground/70' : d?.action === 'done' ? 'text-success' : 'text-brand',
        )}
      >
        {c.error ? 'error' : (d?.action ?? '–')}
        {d?.action === 'answer' && d.messageId !== undefined && ` ${d.messageId}`}
      </span>
      <span className="min-w-0">
        {text && <span className="block whitespace-pre-wrap text-foreground/90">{text}</span>}
        {(d?.why || c.error) && (
          <span className={cn('block', text ? 'text-[11.5px] text-muted-foreground' : 'text-muted-foreground', c.error && 'text-error')}>
            {d?.improvised && (
              <span className="mr-1.5 inline-flex items-center gap-1 font-mono text-[10.5px] text-warning">
                <SparklesIcon className="size-2.5" />
                improvised
              </span>
            )}
            {c.error ?? d?.why}
          </span>
        )}
        <span className="block font-mono text-[10px] text-muted-foreground/50">
          {c.ms !== undefined && `${(c.ms / 1000).toFixed(1)}s`}
          {c.costUsd !== undefined && ` · ${usd(c.costUsd)}`}
        </span>
      </span>
    </li>
  )
}

function Screenshots({ id, names }: { id: string; names: string[] }) {
  const [big, setBig] = useState<string>()
  if (names.length === 0) return <Note>No screenshots: acceptance did not run.</Note>
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {names.map((name) => (
        <Shot big={big === name} id={id} key={name} name={name} toggle={() => setBig(big === name ? undefined : name)} />
      ))}
    </div>
  )
}

function Shot({ id, name, big, toggle }: { id: string; name: string; big: boolean; toggle: () => void }) {
  const src = useAction(ScreenshotAction, { id, name })
  return (
    <figure className={cn('min-w-0', big && 'sm:col-span-2')}>
      <figcaption className="mb-1 font-mono text-[11px] text-muted-foreground">{name.replace(/\.png$/, '')}</figcaption>
      <button
        className="block w-full cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/30 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={toggle}
        type="button"
      >
        {src.data ? (
          <img alt={name} className="block w-full" src={src.data} />
        ) : (
          <span className="block aspect-[16/10] p-3 text-left">
            <Note>{src.error ? errorMessage(src.error) : 'loading…'}</Note>
          </span>
        )}
      </button>
    </figure>
  )
}

function Tests({ r, text }: { r: Result; text?: string }) {
  return (
    <>
      <p className="mb-2 font-mono text-[11.5px]">
        <span className={r.projectTests?.pass ? 'text-success' : r.projectTests ? 'text-error' : 'text-muted-foreground'}>
          {r.projectTests ? (r.projectTests.pass ? 'project tests pass' : 'project tests fail') : 'not run'}
        </span>
        {r.projectTests?.detail && <span className="text-muted-foreground"> · {r.projectTests.detail}</span>}
      </p>
      {text ? (
        <pre className="overflow-x-auto rounded-md bg-terminal px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          {text}
        </pre>
      ) : (
        <Note>No test output.</Note>
      )}
    </>
  )
}

