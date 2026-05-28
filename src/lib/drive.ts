import { db } from '../db/index'
import type { AppSettings, ChildProfile, InterestTag, SessionSummary, LearnedObject } from '../db/index'

// ─── Custom errors ────────────────────────────────────────────────────────────

export class TokenExpiredError extends Error {
  constructor() {
    super('Google access token has expired — please sign in again')
    this.name = 'TokenExpiredError'
  }
}

// ─── Drive file name ──────────────────────────────────────────────────────────

const DRIVE_FILE_NAME = (childName: string): string =>
  `curiouskie-${childName.toLowerCase().replace(/\s+/g, '-')}.json`

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriveProfile {
  profile: ChildProfile
  interestTags: InterestTag[]
  sessionSummaries: SessionSummary[]
  learnedObjects: LearnedObject[]
  apiKeyEncrypted: string
  syncedAt: string
}

interface DriveFileMetadata {
  id: string
  name: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithAuth(url: string, options: RequestInit, accessToken: string): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (response.status === 401) {
    throw new TokenExpiredError()
  }

  return response
}

/**
 * Searches appDataFolder for a file with the given name.
 * Returns file metadata or null if not found.
 */
async function findDriveFile(
  accessToken: string,
  fileName: string
): Promise<DriveFileMetadata | null> {
  const query = encodeURIComponent(
    `name='${fileName}' and trashed=false`
  )
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name)`

  const response = await fetchWithAuth(url, { method: 'GET' }, accessToken)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Drive list error ${response.status}: ${text}`)
  }

  const data = await response.json() as { files: DriveFileMetadata[] }
  return data.files[0] ?? null
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks Google Drive's appDataFolder for an existing profile backup.
 * Returns the profile data if found, or null.
 */
export async function checkDriveForProfile(
  accessToken: string,
  childName: string
): Promise<DriveProfile | null> {
  try {
    const fileName = DRIVE_FILE_NAME(childName)
    const file = await findDriveFile(accessToken, fileName)
    if (!file) return null

    const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
    const response = await fetchWithAuth(url, { method: 'GET' }, accessToken)

    if (!response.ok) return null

    const data = await response.json() as DriveProfile
    return data
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err
    // If we can't reach Drive, return null so onboarding can continue offline
    console.warn('Drive check failed:', err)
    return null
  }
}

/**
 * Saves a DriveProfile to Google Drive's appDataFolder.
 * Creates a new file or updates an existing one.
 */
export async function saveToDrive(
  accessToken: string,
  childName: string,
  data: DriveProfile
): Promise<void> {
  try {
    const fileName = DRIVE_FILE_NAME(childName)
    const existingFile = await findDriveFile(accessToken, fileName)
    const body = JSON.stringify(data)

    if (existingFile) {
      // Update existing file content (media update)
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`

      const response = await fetchWithAuth(
        uploadUrl,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body
        },
        accessToken
      )

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Drive update error ${response.status}: ${text}`)
      }
    } else {
      // Create new file in appDataFolder
      const metadata = {
        name: fileName,
        parents: ['appDataFolder']
      }

      const form = new FormData()
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
      form.append('media', new Blob([body], { type: 'application/json' }))

      const response = await fetchWithAuth(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        { method: 'POST', body: form },
        accessToken
      )

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Drive create error ${response.status}: ${text}`)
      }
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err
    throw new Error(`Drive save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── App-settings file (parent's global settings, mirrors appSettings row) ──
const SETTINGS_FILE_NAME = 'curiouskie-settings.json'

/**
 * Pushes the parent's global app settings (API key, models, PIN hash, time
 * limit, sound, camera, etc.) to a single shared Drive file in appDataFolder.
 * Best-effort: errors are surfaced to the caller (so it can decide to log /
 * ignore) but won't corrupt local state.
 */
export async function uploadAppSettings(
  accessToken: string,
  settings: AppSettings
): Promise<void> {
  const existing = await findDriveFile(accessToken, SETTINGS_FILE_NAME)
  const body = JSON.stringify(settings)

  if (existing) {
    const res = await fetchWithAuth(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
      accessToken
    )
    if (!res.ok) throw new Error(`Drive settings update ${res.status}: ${await res.text()}`)
  } else {
    const metadata = { name: SETTINGS_FILE_NAME, parents: ['appDataFolder'] }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', new Blob([body], { type: 'application/json' }))
    const res = await fetchWithAuth(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', body: form },
      accessToken
    )
    if (!res.ok) throw new Error(`Drive settings create ${res.status}: ${await res.text()}`)
  }
}

/**
 * Pulls the parent's global app settings from Drive. Returns null if no
 * settings file exists yet (first-ever login). Throws TokenExpiredError when
 * the access token is stale so the caller can prompt re-auth.
 */
export async function downloadAppSettings(
  accessToken: string
): Promise<AppSettings | null> {
  const file = await findDriveFile(accessToken, SETTINGS_FILE_NAME)
  if (!file) return null
  const res = await fetchWithAuth(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { method: 'GET' },
    accessToken
  )
  if (!res.ok) throw new Error(`Drive settings fetch ${res.status}: ${await res.text()}`)
  return await res.json() as AppSettings
}

/** Reads current appSettings from IndexedDB and pushes it to Drive. */
export async function syncAppSettingsToDrive(accessToken: string): Promise<void> {
  const s = await db.appSettings.get('main')
  if (!s) return
  await uploadAppSettings(accessToken, s)
}

/**
 * Removes a child's snapshot file from Drive's appDataFolder so the child
 * doesn't reappear in the restore chooser on other devices. Best-effort —
 * a Drive failure should NOT block the local delete.
 */
export async function deleteChildFromDrive(
  accessToken: string,
  childName: string
): Promise<void> {
  try {
    const fileName = DRIVE_FILE_NAME(childName)
    const file = await findDriveFile(accessToken, fileName)
    if (!file) return
    const res = await fetchWithAuth(
      `https://www.googleapis.com/drive/v3/files/${file.id}`,
      { method: 'DELETE' },
      accessToken
    )
    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive delete ${res.status}: ${await res.text()}`)
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err
    // Log but don't throw — local delete already succeeded
    console.warn('Drive child delete failed:', err)
  }
}

/**
 * Fetches the latest uploaded debug log from Drive (appDataFolder). Used by
 * the parent on a *second* device to see what's been recorded elsewhere
 * (e.g. desktop reading the log from mobile).
 * Returns the file's text content, or null if no log has been uploaded yet.
 */
export async function downloadDebugLogFromDrive(
  accessToken: string
): Promise<string | null> {
  const fileName = 'curiouskie-debug.txt'
  const file = await findDriveFile(accessToken, fileName)
  if (!file) return null
  const res = await fetchWithAuth(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { method: 'GET' },
    accessToken
  )
  if (!res.ok) throw new Error(`Drive log fetch ${res.status}: ${await res.text()}`)
  return res.text()
}

/**
 * Lists every child-profile JSON the parent has on Drive (appDataFolder),
 * fetches each, and returns the parsed DriveProfile[]. Used by the
 * "Restore from Drive" chooser shown right after Google sign-in so a new
 * device can recover existing children without re-onboarding.
 */
export async function listDriveChildProfiles(accessToken: string): Promise<DriveProfile[]> {
  try {
    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('spaces', 'appDataFolder')
    // Only our per-child snapshots, not the debug log file
    url.searchParams.set('q', "name contains 'curiouskie-' and name contains '.json' and trashed = false")
    url.searchParams.set('fields', 'files(id,name,modifiedTime)')
    url.searchParams.set('pageSize', '50')

    const listRes = await fetchWithAuth(url.toString(), { method: 'GET' }, accessToken)
    if (!listRes.ok) throw new Error(`Drive list ${listRes.status}: ${await listRes.text()}`)
    const body = await listRes.json() as { files?: Array<{ id: string; name: string }> }
    const files = body.files ?? []

    const results: DriveProfile[] = []
    for (const f of files) {
      try {
        const r = await fetchWithAuth(
          `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
          { method: 'GET' },
          accessToken
        )
        if (!r.ok) continue
        const json = await r.json() as DriveProfile
        // Sanity: must look like one of our snapshots
        if (json?.profile?.id && json?.profile?.name) results.push(json)
      } catch { /* skip a bad file, continue with the rest */ }
    }
    return results
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err
    console.warn('Drive list failed:', err)
    return []
  }
}

/**
 * Saves a plain-text debug log to Drive's appDataFolder (invisible to the
 * user in Drive UI, but recoverable by this app from any device). Used by
 * the debug-mode auto-backup so the log isn't lost if the device is reset.
 *
 * Always overwrites a single file named `curiouskie-debug.txt` (no history).
 */
export async function uploadDebugLogToDrive(
  accessToken: string,
  content: string
): Promise<void> {
  const fileName = 'curiouskie-debug.txt'
  const existing = await findDriveFile(accessToken, fileName)

  if (existing) {
    const res = await fetchWithAuth(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain' },
        body: content
      },
      accessToken
    )
    if (!res.ok) throw new Error(`Drive log update ${res.status}: ${await res.text()}`)
  } else {
    const metadata = { name: fileName, parents: ['appDataFolder'] }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', new Blob([content], { type: 'text/plain' }))
    const res = await fetchWithAuth(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', body: form },
      accessToken
    )
    if (!res.ok) throw new Error(`Drive log create ${res.status}: ${await res.text()}`)
  }
}

/**
 * Builds a sync snapshot from IndexedDB for the given profile.
 * Reads top 20 interest tags, last 7 session summaries, last 100 learned objects.
 */
export async function buildSyncSnapshot(profileId: string): Promise<DriveProfile> {
  const profile = await db.childProfiles.get(profileId)
  if (!profile) throw new Error(`Profile not found: ${profileId}`)

  const settings = await db.appSettings.get('main')

  // Top 20 interest tags by weight
  const allTags = await db.interestTags
    .where('profileId').equals(profileId)
    .toArray()
  const interestTags = allTags
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20)

  // Last 7 session summaries
  const allSummaries = await db.sessionSummaries
    .where('profileId').equals(profileId)
    .toArray()
  const sessionSummaries = allSummaries
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 7)

  // Last 100 learned objects
  const allObjects = await db.learnedObjects
    .where('profileId').equals(profileId)
    .toArray()
  const learnedObjects = allObjects
    .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
    .slice(0, 100)

  return {
    profile,
    interestTags,
    sessionSummaries,
    learnedObjects,
    apiKeyEncrypted: settings?.apiKeyEncrypted ?? '',
    syncedAt: new Date().toISOString()
  }
}
