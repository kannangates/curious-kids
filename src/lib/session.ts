import { db, safeDbWrite } from '../db/index'
import { buildSyncSnapshot, saveToDrive } from './drive'
import { useAppStore } from '../store/app'
import type { GeminiClient } from './gemini'
import { buildSessionSummaryPrompt } from '../prompts/index'
import { extractTopics, bumpInterest } from './memory'

// ─── Session trigger setup ────────────────────────────────────────────────────

/**
 * Registers page visibility and unload event listeners to detect session end.
 * Returns a cleanup function that removes all listeners.
 */
export function initSessionTriggers(onSessionEnd: () => void): () => void {
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      onSessionEnd()
    }
  }

  const handlePageHide = (): void => {
    onSessionEnd()
  }

  const handleBeforeUnload = (): void => {
    onSessionEnd()
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handleBeforeUnload)

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('pagehide', handlePageHide)
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
}

// ─── Idle timer ───────────────────────────────────────────────────────────────

export interface IdleTimer {
  reset: () => void
  clear: () => void
}

/**
 * Creates an idle timer that fires onIdle after `ms` milliseconds of no activity.
 * Default is 90 seconds (90000ms).
 */
export function createIdleTimer(onIdle: () => void, ms = 90_000): IdleTimer {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let paused = false

  const handleVisibility = (): void => {
    paused = document.hidden
  }
  document.addEventListener('visibilitychange', handleVisibility)

  const clear = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    document.removeEventListener('visibilitychange', handleVisibility)
  }

  const reset = (): void => {
    if (paused) return
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    timeoutId = setTimeout(() => {
      if (paused) { reset(); return }
      onIdle()
    }, ms)
  }

  // Start the timer immediately
  reset()

  return { reset, clear }
}

// ─── Session summary generation ───────────────────────────────────────────────

interface SummaryResponse {
  summary: string
  topicsExplored: string[]
  newInterests: string[]
  emotionalNote: string
}

function parseSummaryResponse(text: string): SummaryResponse {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<SummaryResponse>
      return {
        summary: typeof parsed.summary === 'string'
          ? parsed.summary.slice(0, 200)
          : 'Had a great learning session!',
        topicsExplored: Array.isArray(parsed.topicsExplored) ? parsed.topicsExplored : [],
        newInterests: Array.isArray(parsed.newInterests) ? parsed.newInterests : [],
        emotionalNote: typeof parsed.emotionalNote === 'string'
          ? parsed.emotionalNote
          : 'Curious and engaged'
      }
    } catch {
      // Fall through to default
    }
  }

  // Fallback: use raw text as summary
  return {
    summary: text.slice(0, 200),
    topicsExplored: [],
    newInterests: [],
    emotionalNote: 'Had fun exploring!'
  }
}

/**
 * Generates a session summary using Gemini, saves it to IndexedDB,
 * prunes old summaries (keeps 7 days), updates interest tags,
 * and triggers a Drive sync.
 */
export async function generateSessionSummary(
  profileId: string,
  topics: string[],
  durationMs: number,
  geminiClient: GeminiClient
): Promise<void> {
  if (topics.length === 0) return // Nothing to summarize

  const durationMinutes = Math.round(durationMs / 60_000)

  try {
    const prompt = buildSessionSummaryPrompt(topics, durationMinutes)

    let summaryText = ''
    try {
      summaryText = await geminiClient.streamChat(
        'You are a helpful assistant that summarizes children\'s learning sessions in JSON format.',
        prompt,
        () => { /* no streaming display needed for summary */ }
      )
    } catch {
      // If Gemini fails, create a basic summary from topics
      summaryText = JSON.stringify({
        summary: `Explored ${topics.slice(0, 3).join(', ')} for ${durationMinutes} minutes`,
        topicsExplored: topics,
        newInterests: topics.slice(0, 2),
        emotionalNote: 'Curious and engaged'
      })
    }

    const parsed = parseSummaryResponse(summaryText)

    // Generate UUID for summary
    const summaryId = crypto.randomUUID()
    const now = new Date().toISOString()

    // Save summary to IndexedDB
    await safeDbWrite(() => db.sessionSummaries.add({
      id: summaryId,
      profileId,
      date: now,
      summary: parsed.summary,
      topicsExplored: parsed.topicsExplored,
      newInterests: parsed.newInterests,
      emotionalNote: parsed.emotionalNote
    }))

    // Prune summaries older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const oldSummaries = await db.sessionSummaries
      .where('profileId').equals(profileId)
      .filter(s => s.date < sevenDaysAgo)
      .toArray()

    if (oldSummaries.length > 0) {
      await safeDbWrite(() => db.sessionSummaries.bulkDelete(oldSummaries.map(s => s.id)))
    }

    // Bump interests for all topics + new interests via bumpInterest (has safeDbWrite).
    // Deduplicate with a Set to avoid double-bumping overlapping terms.
    const newInterestSet = new Set(parsed.newInterests.map(t => t.toLowerCase().trim()))
    const allTerms = new Set<string>()
    parsed.newInterests.forEach(t => { if (t && typeof t === 'string') allTerms.add(t.toLowerCase().trim()) })
    topics.forEach(t => { if (t) allTerms.add(t.toLowerCase().trim()) })

    // Also extract keywords from the full combined text for extra coverage
    const fullTopicText = [...topics, ...parsed.topicsExplored, ...parsed.newInterests].join(' ')
    extractTopics(fullTopicText).forEach(k => allTerms.add(k))

    for (const term of allTerms) {
      if (term) await bumpInterest(profileId, term, newInterestSet.has(term) ? 1 : 0.5)
    }

    // Trigger Drive sync if we have credentials
    const store = useAppStore.getState()
    if (store.googleToken && store.profile) {
      try {
        const snapshot = await buildSyncSnapshot(profileId)
        await saveToDrive(store.googleToken, store.profile.name, snapshot)
        // Update lastSyncedAt
        await safeDbWrite(() => db.appSettings.update('main', { lastSyncedAt: now }))
      } catch (syncErr) {
        // Drive sync failure is non-fatal
        console.warn('Drive sync failed after session summary:', syncErr)
      }
    }
  } catch (err) {
    // Session summary failure is non-fatal — log but don't throw
    console.error('Failed to generate session summary:', err)
  }
}
