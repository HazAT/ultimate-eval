// The overview: the run in progress, then the matrix (commit × setup × scenario), each row's runs a click away.
import { cn } from '@/sdk'
import { LiveRuns } from './live.tsx'
import { Box, Dot, Note, Section } from './parts.tsx'
import { mins, short, toneOf, toneText, usd, verdict } from './types.ts'
import type { Group, Overview as Data, Summary } from './types.ts'

export function Overview({
  data,
  open,
  refetch,
}: {
  data: Data
  open: (id: string) => void
  refetch: () => void
}) {
  const byId = new Map(data.runs.map((r) => [r.id, r]))
  const cancelled = data.runs.filter((r) => r.status === 'cancelled').length
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-5 md:px-6">
      <Section title="now">
        {data.live.length > 0 ? (
          <LiveRuns live={data.live} onCancelled={refetch} />
        ) : (
          <Box className="px-3 py-2.5">
            <Note>
              No run in progress. Ask the agent to start one, such as “run the eval on main, 3
              repeats”.
            </Note>
          </Box>
        )}
      </Section>

      <Section
        aside={
          cancelled > 0 && `${cancelled} cancelled left out`
        }
        title="matrix"
      >
        {data.matrix.length === 0 ? (
          <Note>No finished runs yet.</Note>
        ) : (
          <Box>
            <ul className="divide-y divide-border/50">
              {data.matrix.map((g) => (
                <Row byId={byId} group={g} key={g.ids.join()} open={open} />
              ))}
            </ul>
          </Box>
        )}
      </Section>
    </div>
  )
}

/** One group: pass/N first, what it pinned, its medians; then the features and each run, failures saying why. */
function Row({
  group: g,
  byId,
  open,
}: {
  group: Group
  byId: Map<string, Summary>
  open: (id: string) => void
}) {
  const rate = g.n ? g.passes / g.n : 0
  // The group counts only passing features; its runs name the ones that never passed too.
  const names = new Set(Object.keys(g.features))
  for (const id of g.ids) for (const f of Object.keys(byId.get(id)?.features ?? {})) names.add(f)
  const features = [...names].map((f) => [f, g.features[f] ?? 0] as const)
  return (
    <li className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-3 py-2.5 font-mono text-[11.5px]">
      <span
        className={cn(
          'row-span-2 text-[15px] leading-tight tabular-nums',
          rate === 1 ? 'text-success' : rate === 0 ? 'text-error' : 'text-warning',
        )}
        title={`${g.passes} of ${g.n} runs passed`}
      >
        {g.passes}/{g.n}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="truncate">
          <span className="text-foreground">{short(g.commit)}</span>
          <span className="text-muted-foreground">
            {' '}
            · {g.setup} · {g.scenario}
            <span className="text-muted-foreground/60">@{g.scenarioSha.slice(0, 6)}</span>
          </span>
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          median <span className="text-foreground/85">{mins(g.medianMin)}</span> ·{' '}
          <span className="text-foreground/85">{usd(g.medianCost)}</span>
        </span>
      </span>
      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {features.map(([name, count]) => (
          <span
            className={cn(count === g.n ? 'text-muted-foreground/70' : 'text-warning')}
            key={name}
            title={`${name}: ${count} of ${g.n} runs pass it`}
          >
            {name} {count}/{g.n}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap gap-1">
          {g.ids.map((id) => {
            const r = byId.get(id)
            const tone = r ? toneOf(r) : 'cancelled'
            return (
              <button
                className="flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                key={id}
                onClick={() => open(id)}
                title={`${id}${r ? ` · ${verdict(r)} · ${mins(r.minutes ?? r.failure?.atMin)} · ${usd(r.costUsd)}` : ''}`}
                type="button"
              >
                <Dot tone={tone} />
                {id.slice(-4)}
                {r && !r.pass && (
                  <span className={toneText[tone]}>
                    {verdict(r)}
                    {r.failure?.atMin !== undefined && ` ${Math.round(r.failure.atMin)}m`}
                  </span>
                )}
              </button>
            )
          })}
        </span>
      </span>
    </li>
  )
}
