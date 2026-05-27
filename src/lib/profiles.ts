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
 * plus their per-child localStorage (XP, usage, camera consent). Leaves the
 * shared app settings / API key intact UNLESS this was the last child, in which
 * case settings are wiped for a clean slate. Returns the remaining profiles.
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
    // Last child removed → wipe shared settings for a fresh start
    try { await db.appSettings.delete('main') } catch { /* ignore */ }
    clearActiveProfileId()
  } else if (getActiveProfileId() === profileId) {
    // Deleted the active child → point to the next most-recent one
    setActiveProfileId(remaining[0].id)
  }

  return remaining
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
