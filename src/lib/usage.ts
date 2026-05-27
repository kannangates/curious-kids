// Daily usage tracking for the parent-controlled session time limit.
// Stored per-child, per-calendar-day in localStorage so it resets each morning
// automatically (the date is part of the key). No DB version bump required.

function dayKey(profileId: string): string {
  const today = new Date().toDateString() // e.g. "Tue May 27 2026"
  return `ck_usage_${profileId}_${today}`
}

/** Returns the number of whole seconds the child has used the app today. */
export function getUsageSeconds(profileId: string): number {
  try {
    const raw = localStorage.getItem(dayKey(profileId))
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Adds `seconds` to today's usage tally and returns the new total. */
export function addUsageSeconds(profileId: string, seconds: number): number {
  if (seconds <= 0) return getUsageSeconds(profileId)
  const next = getUsageSeconds(profileId) + Math.round(seconds)
  try {
    localStorage.setItem(dayKey(profileId), String(next))
  } catch {
    /* quota / private mode — ignore */
  }
  return next
}

/** Total minutes used over the last `days` calendar days (default 7). */
export function getRecentUsageMinutes(profileId: string, days = 7): number {
  let totalSec = 0
  const now = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    const key = `ck_usage_${profileId}_${d.toDateString()}`
    try {
      const raw = localStorage.getItem(key)
      const n = raw ? Number(raw) : 0
      if (Number.isFinite(n) && n > 0) totalSec += n
    } catch {
      /* ignore */
    }
  }
  return Math.round(totalSec / 60)
}

/**
 * Parent override: clears today's usage so the child can keep playing.
 * Used by the "Give 5 more minutes" parent action on the Time's Up screen.
 */
export function grantBonusMinutes(profileId: string, minutes: number): void {
  try {
    const current = getUsageSeconds(profileId)
    const reduced = Math.max(0, current - minutes * 60)
    localStorage.setItem(dayKey(profileId), String(reduced))
  } catch {
    /* ignore */
  }
}
