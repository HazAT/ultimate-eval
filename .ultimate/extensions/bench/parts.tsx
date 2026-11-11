// Small shared pieces of the Bench surface: section headings, status dots, empty notes, the tab bar.
import type { ReactNode } from 'react'
import { cn } from '@/sdk'
import { toneDot } from './types.ts'
import type { Tone } from './types.ts'

export const dot = 'inline-block size-1.5 shrink-0 rounded-full'

export function Dot({ tone, pulse }: { tone: Tone | 'live'; pulse?: boolean }) {
  return (
    <span
      className={cn(dot, tone === 'live' ? 'bg-brand' : toneDot[tone], pulse && 'animate-pulse-dot')}
    />
  )
}

/** A quiet section: a mono label, an optional aside on its right, then its content. */
export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="section-label">{title}</h2>
        {aside && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">{aside}</span>
        )}
      </div>
      {children}
    </section>
  )
}

/** A bordered box like the System surface's. */
export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border/70 bg-card/40', className)}>{children}</div>
  )
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('font-mono text-[11.5px] text-muted-foreground/70', className)}>{children}</p>
  )
}

/** Small mono tabs, as the System surface's Agents/Wire. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; title: string; count?: number | string }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <span className="flex flex-wrap items-center gap-0.5 font-mono text-[11px]" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={tab.id === value}
          className={cn(
            'h-6 cursor-pointer rounded-md px-2 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
            tab.id === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          type="button"
        >
          {tab.title}
          {tab.count !== undefined && (
            <span className="ml-1 text-muted-foreground/70">{tab.count}</span>
          )}
        </button>
      ))}
    </span>
  )
}

/** A label/value grid for meta. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]">
      {rows.map(([label, value]) => (
        <div className="contents" key={label}>
          <dt className="truncate text-muted-foreground/70">{label}</dt>
          <dd className="min-w-0 break-words text-foreground/85">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
