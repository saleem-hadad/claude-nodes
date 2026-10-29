import { useEffect, useReducer } from 'react'
import clsx from 'clsx'
import type { SessionUsage } from '@shared/types'
import { formatDuration } from '@renderer/store'
import './UsageStats.css'

/**
 * Claude's status line, for a session's header: the model, how full its
 * context is, how long it has been running and what it has cost so far.
 * Nothing until Claude has reported.
 */
export function UsageStats({ usage, live, className }: { usage?: SessionUsage; live: boolean; className?: string }) {
  if (!usage) return null
  const { model, contextPercent, costUsd } = usage
  const level = contextPercent === undefined ? undefined : contextPercent >= 90 ? 'full' : contextPercent >= 75 ? 'high' : undefined

  return (
    <div className={clsx('usage', className)}>
      {model && (
        <span className="usage-item usage-model" title="Model">
          {model}
        </span>
      )}
      {contextPercent !== undefined && (
        <span className="usage-item usage-context" data-level={level} title={contextTitle(usage)}>
          <span className="usage-meter" aria-hidden>
            <span style={{ width: `${Math.min(100, contextPercent)}%` }} />
          </span>
          Ctx {Math.round(contextPercent)}%
        </span>
      )}
      {usage.durationMs !== undefined && <RunningTime usage={usage} live={live} />}
      {costUsd !== undefined && (
        <span className="usage-item" title="Cost so far">
          {formatCost(costUsd)}
        </span>
      )}
    </div>
  )
}

/** Counts on from Claude's last report while the session runs; Claude only reports after replies. */
function RunningTime({ usage, live }: { usage: SessionUsage; live: boolean }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const ms = usage.durationMs! + (live ? Math.max(0, Date.now() - usage.at) : 0)
  return (
    <span className="usage-item" title="Time the session has been running">
      {formatDuration(ms)}
    </span>
  )
}

function contextTitle({ contextTokens, contextSize }: SessionUsage): string {
  if (contextTokens === undefined || !contextSize) return 'Context window in use'
  return `${formatTokens(contextTokens)} of ${formatTokens(contextSize)} tokens in context`
}

/** 950, 9.5k, 106k, 1M. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function formatCost(usd: number): string {
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}
