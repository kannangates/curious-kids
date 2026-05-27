// XP / Stars system for CuriousKids AI
// Stored in localStorage under key `ck_xp_${profileId}` to avoid a DB version bump.

// ─── Types ────────────────────────────────────────────────────────────────────

export type XPEvent = 'photo_taken' | 'word_learned' | 'quiz_correct' | 'chat_session'

export interface XPData {
  totalXP: number
  level: string       // e.g. 'Explorer'
  levelEmoji: string
  nextLevelXP: number // XP needed to reach the NEXT level threshold
}

// ─── XP table ─────────────────────────────────────────────────────────────────

const XP_PER_EVENT: Record<XPEvent, number> = {
  photo_taken:  5,
  word_learned: 10,
  quiz_correct: 15,
  chat_session: 3
}

// ─── Level thresholds ─────────────────────────────────────────────────────────

interface Level {
  name: string
  emoji: string
  minXP: number
}

const LEVELS: Level[] = [
  { name: 'Explorer',   emoji: '⭐',  minXP: 0   },
  { name: 'Adventurer', emoji: '🌟',  minXP: 50  },
  { name: 'Scholar',    emoji: '💫',  minXP: 150 },
  { name: 'Champion',   emoji: '🏆',  minXP: 300 }
]

// ─── Internal helpers ─────────────────────────────────────────────────────────

function storageKey(profileId: string): string {
  return `ck_xp_${profileId}`
}

function readRawXP(profileId: string): number {
  try {
    const raw = localStorage.getItem(storageKey(profileId))
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { totalXP?: unknown }
    const xp = parsed?.totalXP
    return typeof xp === 'number' && isFinite(xp) && xp >= 0 ? Math.floor(xp) : 0
  } catch {
    return 0
  }
}

function writeRawXP(profileId: string, totalXP: number): void {
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify({ totalXP }))
  } catch {
    // Quota exceeded or private browsing — silently ignore
    console.warn('[xp] localStorage write failed')
  }
}

function computeXPData(totalXP: number): XPData {
  // Find the highest level the user has reached
  let currentLevel = LEVELS[0]
  for (const lvl of LEVELS) {
    if (totalXP >= lvl.minXP) {
      currentLevel = lvl
    }
  }

  // Find the next level (if any)
  const currentIdx = LEVELS.indexOf(currentLevel)
  const nextLevel = LEVELS[currentIdx + 1] ?? null

  const nextLevelXP = nextLevel
    ? nextLevel.minXP - totalXP
    : 0 // Already Champion — no next level

  return {
    totalXP,
    level: currentLevel.name,
    levelEmoji: currentLevel.emoji,
    nextLevelXP: Math.max(0, nextLevelXP)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Awards XP for an event and returns the updated XPData.
 * Also returns the previous XPData so callers can detect level-ups.
 */
export async function addXP(
  profileId: string,
  event: XPEvent
): Promise<{ current: XPData; previous: XPData; gained: number }> {
  const gained = XP_PER_EVENT[event] ?? 0
  const prevTotal = readRawXP(profileId)
  const newTotal  = prevTotal + gained

  writeRawXP(profileId, newTotal)

  return {
    previous: computeXPData(prevTotal),
    current:  computeXPData(newTotal),
    gained
  }
}

/**
 * Returns the current XPData for a profile without modifying it.
 */
export async function getXPData(profileId: string): Promise<XPData> {
  return computeXPData(readRawXP(profileId))
}
