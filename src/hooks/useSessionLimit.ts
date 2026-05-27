import { useEffect, useRef, useState } from 'react'
import { db } from '../db/index'
import { getUsageSeconds, addUsageSeconds } from '../lib/usage'

const TICK_MS = 15_000 // accrue usage every 15s while the app is visible

export interface SessionLimitState {
  limitReached: boolean
  minutesUsed: number
  limitMinutes: number
  /** Force a re-check (e.g. after a parent grants bonus minutes) */
  refresh: () => void
}

/**
 * Tracks the child's daily active usage and compares it against the
 * parent-configured `sessionTimeLimit` (minutes) from AppSettings.
 *
 * Usage only accrues while the document is visible, so leaving the app open
 * in the background doesn't burn the allowance.
 */
export function useSessionLimit(profileId: string | undefined): SessionLimitState {
  const [limitMinutes, setLimitMinutes] = useState<number>(0)
  const [minutesUsed, setMinutesUsed] = useState<number>(0)
  const [limitReached, setLimitReached] = useState(false)
  const [version, setVersion] = useState(0) // bump to force re-evaluation

  const lastTickRef = useRef<number>(Date.now())

  // Load the configured limit
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const settings = await db.appSettings.get('main')
        if (!cancelled) setLimitMinutes(settings?.sessionTimeLimit ?? 0)
      } catch {
        if (!cancelled) setLimitMinutes(0)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [version])

  // Accrue usage on an interval while visible
  useEffect(() => {
    if (!profileId) return

    // Seed current usage immediately
    const used = getUsageSeconds(profileId)
    setMinutesUsed(Math.floor(used / 60))
    lastTickRef.current = Date.now()

    const tick = () => {
      if (document.hidden) {
        // Don't count background time — just reset the anchor
        lastTickRef.current = Date.now()
        return
      }
      const now = Date.now()
      const elapsedSec = (now - lastTickRef.current) / 1000
      lastTickRef.current = now
      const total = addUsageSeconds(profileId, elapsedSec)
      setMinutesUsed(Math.floor(total / 60))
    }

    const id = setInterval(tick, TICK_MS)

    // Also accrue when the tab is hidden so a long chat still counts up to that point
    const onVisibility = () => {
      if (document.hidden) tick()
      else lastTickRef.current = Date.now()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [profileId, version])

  // Evaluate whether the limit is reached
  useEffect(() => {
    // limitMinutes <= 0 means "no limit"
    if (limitMinutes > 0 && minutesUsed >= limitMinutes) {
      setLimitReached(true)
    } else {
      setLimitReached(false)
    }
  }, [limitMinutes, minutesUsed])

  return {
    limitReached,
    minutesUsed,
    limitMinutes,
    refresh: () => setVersion(v => v + 1)
  }
}
