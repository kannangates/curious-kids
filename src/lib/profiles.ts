import { db } from '../db/index'
import type { ChildProfile } from '../db/index'

// Tracks which child profile is currently active (multi-child support).
// All children belong to the same signed-in Google account and share the
// parent's single encrypted API key in appSettings; only the active child
// profile changes when switching.

const ACTIVE_KEY = 'ck_active_profile_id'

export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function setActiveProfileId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* private mode / quota — ignore */
  }
}

export function clearActiveProfileId(): void {
  try { localStorage.removeItem(ACTIVE_KEY) } catch { /* ignore */ }
}

/** All child profiles, most-recently-active first. */
export async function listProfiles(): Promise<ChildProfile[]> {
  const all = await db.childProfiles.toArray()
  return all.sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  )
}

/**
 * Deletes one child and ALL of their data (interests, summaries, discoveries)
 * plus their per-child localStorage (XP, usage, camera consent). The shared
 * appSettings row — which holds the encrypted Gemini API key, the parent
 * PIN hash, the chosen models, time limit etc. — is ALWAYS preserved, even
 * when the last child is deleted, so the parent doesn't have to re-enter
 * their key when adding a new child. Returns the remaining profiles.
 */
export async function deleteProfile(profileId: string): Promise<ChildProfile[]> {
  await db.transaction(
    'rw',
    [db.childProfiles, db.interestTags, db.sessionSummaries, db.learnedObjects],
    async () => {
      await db.childProfiles.delete(profileId)
      await db.interestTags.where('profileId').equals(profileId).delete()
      await db.sessionSummaries.where('profileId').equals(profileId).delete()
      await db.learnedObjects.where('profileId').equals(profileId).delete()
    }
  )

  // Per-child localStorage cleanup
  try {
    localStorage.removeItem(`ck_xp_${profileId}`)
    localStorage.removeItem(`ck_camera_consent_${profileId}`)
    const usagePrefix = `ck_usage_${profileId}_`
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(usagePrefix)) toRemove.push(k)
    }
    toRemove.forEach(k => localStorage.removeItem(k))
  } catch { /* ignore */ }

  const remaining = await listProfiles()

  if (remaining.length === 0) {
    // Last child removed — clear the active-profile pointer but KEEP appSettings
    // (parent's API key stays, so adding a new child is friction-free).
    clearActiveProfileId()
  } else if (getActiveProfileId() === profileId) {
    // Deleted the active child → point to the next most-recent one
    setActiveProfileId(remaining[0].id)
  }

  return remaining
}

/**
 * Resets a child's "memory" within a time window. `days = null` clears
 * everything; otherwise only entries from the last N days are removed.
 *
 * Memory = the three AI-context tables: interestTags, sessionSummaries,
 * learnedObjects. The child PROFILE, XP and parent settings are untouched.
 */
export async function resetMemoryForProfile(
  profileId: string,
  days: number | null
): Promise<{ interests: number; summaries: number; objects: number }> {
  const cutoffMs = days == null ? null : Date.now() - days * 24 * 60 * 60 * 1000
  const after = (iso: string) => cutoffMs == null || new Date(iso).getTime() >= cutoffMs

  let interests = 0, summaries = 0, objects = 0

  await db.transaction(
    'rw',
    [db.interestTags, db.sessionSummaries, db.learnedObjects],
    async () => {
      // interestTags: filter by lastMentioned
      const tags = await db.interestTags.where('profileId').equals(profileId).toArray()
      const tagsToDelete = tags.filter(t => after(t.lastMentioned))
      if (tagsToDelete.length > 0) {
        const ids = tagsToDelete.map(t => t.id!).filter(Boolean)
        await db.interestTags.bulkDelete(ids)
        interests = tagsToDelete.length
      }

      // sessionSummaries: filter by date
      const sums = await db.sessionSummaries.where('profileId').equals(profileId).toArray()
      const sumsToDelete = sums.filter(s => after(s.date))
      if (sumsToDelete.length > 0) {
        await db.sessionSummaries.bulkDelete(sumsToDelete.map(s => s.id))
        summaries = sumsToDelete.length
      }

      // learnedObjects: filter by learnedAt
      const objs = await db.learnedObjects.where('profileId').equals(profileId).toArray()
      const objsToDelete = objs.filter(o => after(o.learnedAt))
      if (objsToDelete.length > 0) {
        await db.learnedObjects.bulkDelete(objsToDelete.map(o => o.id))
        objects = objsToDelete.length
      }
    }
  )

  return { interests, summaries, objects }
}

/**
 * Resolves which profile should be active on app load:
 * the stored active id if it still exists, else the most-recently-active one.
 */
export async function resolveActiveProfile(): Promise<ChildProfile | null> {
  const all = await listProfiles()
  if (all.length === 0) return null
  const activeId = getActiveProfileId()
  if (activeId) {
    const found = all.find(p => p.id === activeId)
    if (found) return found
  }
  return all[0]
}
