// The run in progress: phase, elapsed against the budget, what the coordinators did, what was said last, and cancel.
import { CheckIcon, EyeIcon, SquareIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, cn, errorMessage, formatAgo, useNow } from '@/sdk'
import { Box, Dot, Note } from './parts.tsx'
import { CancelAction, clock, short, when } from './types.ts'
import type { InProgress, Legacy, Running } from './types.ts'

const PHASES = ['preparing', 'installing', 'starting', 'opening', 'running', 'collecting', 'accepting']

export function LiveRuns({ live, onCancelled }: { live: InProgress[]; onCancelled: () => void }) {
  return (
    <div className="space-y-3">
      {live.map((run) =>
        run.kind === 'running' ? (
          <RunningCard key={run.id} onCancelled={onCancelled} run={run} />
        ) : (
          <LegacyCard key={run.id} run={run} />
        ),
      )}
    </div>
  )
}

function LegacyCard({ run }: { run: Legacy }) {
  const now = useNow(10_000)
  return (
    <Box className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 font-mono text-[11.5px]">
      <Dot pulse tone="live" />
      <span className="text-foreground">running</span>
      <span className="text-muted-foreground">{short(run.commit)}</span>
      <span className="text-muted-foreground/70">
        started {formatAgo(run.launchedAt, now, { ago: true })}
      </span>
      <span className="ml-auto text-muted-foreground/70">
        older runner · no live detail · stop it from its terminal
      </span>
    </Box>
  )
}

function RunningCard({ run, onCancelled }: { run: Running; onCancelled: () => void }) {
  const now = useNow(1000)
  const budget = run.budgetMin * 60_000
  const started = run.firstPromptAt
  const elapsed = started ? now - started : 0
  const share = started ? Math.min(1, elapsed / budget) : 0
  const over = started !== undefined && elapsed > budget
  const lastSaid = run.said.at(-1)
  const quietMin = lastSaid ? (now - lastSaid.at) / 60_000 : undefined
  const landed = run.coordinators.filter((c) => c.landed).length
  const others = run.busy.filter((b) => !run.coordinators.some((c) => c.id === b.id))
  return (
    <Box className="overflow-hidden">
      {/* What, where, and the one control */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11.5px]">
        <Dot pulse tone="live" />
        <span className="text-foreground">{run.phase}</span>
        <span className="text-muted-foreground">
          {short(run.commit)} · {run.setup} · {run.scenario}
        </span>
        {run.repeat.total > 1 && (
          <span className="text-muted-foreground/70">
            repeat {run.repeat.index}/{run.repeat.total}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <CancelButton onCancelled={onCancelled} run={run} />
        </span>
      </div>

      <div className="space-y-4 px-3 py-3">
        {/* Elapsed against the budget: the focal point */}
        <div>
          <div className="flex items-baseline gap-2 font-mono">
            <span
              className={cn(
                'text-[22px] leading-none tabular-nums',
                over ? 'text-error' : share > 0.8 ? 'text-warning' : 'text-foreground',
              )}
            >
              {started ? clock(elapsed) : '–:––'}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              {started ? `of ${run.budgetMin}:00` : `no prompt yet · launched ${when(run.launchedAt)}`}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground/70">
              {quietMin !== undefined && (
                <span title="The last thing said between Ultimate and the simulated user; work in between does not show here">
                  last said {formatAgo(lastSaid!.at, now, { ago: true })}
                </span>
              )}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-1000 ease-linear',
                over ? 'bg-error' : share > 0.8 ? 'bg-warning' : 'bg-brand',
              )}
              style={{ width: `${share * 100}%` }}
            />
          </div>
          <Phases phase={run.phase} />
        </div>

        {/* Coordinators, landed or working, then anything else busy and cards waiting */}
        <div>
          <h3 className="section-label mb-1">
            coordinators{' '}
            <span className="text-muted-foreground/70">
              {landed}/{run.coordinators.length} landed
            </span>
          </h3>
          {run.coordinators.length === 0 ? (
            <Note>none started yet</Note>
          ) : (
            <ul className="space-y-0.5 text-[12.5px]">
              {run.coordinators.map((c) => {
                const busy = run.busy.some((b) => b.id === c.id)
                return (
                  <li className="flex min-w-0 items-center gap-2" key={c.id}>
                    {c.landed ? (
                      <CheckIcon className="size-3 shrink-0 text-success" />
                    ) : (
                      <span className="flex size-3 shrink-0 items-center justify-center">
                        <Dot pulse={busy} tone={busy ? 'live' : 'cancelled'} />
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground/70">#{c.id}</span>
                    <span className={cn('truncate', !c.landed && !busy && 'text-muted-foreground')}>
                      {c.intent ?? c.title}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                      {c.landed ? 'landed' : busy ? 'working' : 'idle'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {others.length > 0 && (
            <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
              also busy{' '}
              {others.map((b) => `#${b.id} ${b.label ?? b.title ?? ''}`.trim()).join(' · ')}
            </p>
          )}
          {run.open > 0 && (
            <p className="mt-1.5 font-mono text-[11px] text-warning">
              {run.open} card{run.open === 1 ? '' : 's'} waiting for the simulated user
            </p>
          )}
        </div>

        {run.said.length > 0 && (
          <div>
            <h3 className="section-label mb-1">latest</h3>
            <Said said={run.said.slice(-4)} />
          </div>
        )}
      </div>

      {run.url && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 px-3 py-2 font-mono text-[11px]">
          <EyeIcon className="size-3 text-muted-foreground" />
          <a
            className="text-foreground/85 underline decoration-border underline-offset-2 hover:decoration-foreground"
            href={run.url}
            rel="noreferrer"
            target="_blank"
          >
            {run.url}
          </a>
          <span className="rounded-sm bg-warning/15 px-1.5 py-px text-warning">watch only</span>
          <span className="text-muted-foreground/70">
            anything you click there acts as the user and disturbs the run
          </span>
        </div>
      )}
    </Box>
  )
}

/** The runner's phases as a quiet trail, the current one lit. */
function Phases({ phase }: { phase: string }) {
  const at = PHASES.indexOf(phase)
  return (
    <ol className="mt-1.5 flex flex-wrap gap-x-2 font-mono text-[10.5px]">
      {PHASES.map((p, i) => (
        <li
          className={cn(
            i === at ? 'text-brand' : i < at ? 'text-muted-foreground' : 'text-muted-foreground/40',
          )}
          key={p}
        >
          {p}
        </li>
      ))}
    </ol>
  )
}

/** Turns between the simulated user (`you`) and Ultimate, as short lines. */
export function Said({ said }: { said: { at: number; who: string; text: string }[] }) {
  return (
    <ul className="space-y-1.5">
      {said.map((s, i) => (
        <li className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2 text-[12.5px]" key={`${s.at}-${i}`}>
          <span
            className={cn(
              'pt-px font-mono text-[11px]',
              s.who === 'you' ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            {s.who === 'you' ? 'sim user' : 'ultimate'}
          </span>
          <span className="line-clamp-3 whitespace-pre-wrap text-foreground/85">{s.text}</span>
        </li>
      ))}
    </ul>
  )
}

function CancelButton({ run, onCancelled }: { run: Running; onCancelled: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const remaining = run.repeat.total - run.repeat.index
  const cancel = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(CancelAction, { id: run.id })
      setOpen(false)
      onCancelled()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        className="h-6 font-mono text-[11px] text-muted-foreground hover:text-error"
        onClick={() => setOpen(true)}
        size="xs"
        variant="ghost"
      >
        <SquareIcon className="size-2.5" />
        cancel
      </Button>
      <Dialog onOpenChange={(next) => !busy && setOpen(next)} open={open}>
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogTitle className="text-[15px] font-medium">Cancel this run?</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Run <span className="font-mono text-foreground/85">{run.id}</span> stops now and is
            recorded as cancelled, outside the matrix.
            {remaining > 0 && (
              <>
                {' '}
                The {remaining} remaining repeat{remaining === 1 ? '' : 's'} won't start.
              </>
            )}{' '}
            The quota it spent so far is not recovered.
          </DialogDescription>
          {error && <p className="font-mono text-[11.5px] break-words text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setOpen(false)} size="sm" variant="ghost">
              Keep running
            </Button>
            <Button disabled={busy} onClick={() => void cancel()} size="sm" variant="destructive">
              {busy ? 'Cancelling…' : 'Cancel run'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
