import Dexie, { type Table } from 'dexie'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MascotChoice = 'lion' | 'owl' | 'bunny'

export interface ChildProfile {
  id: string                    // UUID
  googleId: string              // Google sub
  name: string
  age: number                   // child's age (not capped — AI adapts to it)
  mascotChoice: MascotChoice
  preferredLanguages: string[]  // e.g. ['en', 'kn']
  createdAt: string             // ISO date string
  lastActiveAt: string          // ISO date string
}

export interface InterestTag {
  id?: number                   // auto-increment
  profileId: string
  tag: string
  weight: number                // 0–10
  lastMentioned: string         // ISO date string
}

export interface SessionSummary {
  id: string                    // UUID
  profileId: string
  date: string                  // ISO date string
  summary: string               // max 200 chars
  topicsExplored: string[]
  newInterests: string[]
  emotionalNote: string
}

export interface LearnedObject {
  id: string                    // UUID
  profileId: string
  objectName: string
  emoji: string
  translations: string          // JSON string: { [langCode: string]: string }
  learnedAt: string             // ISO date string
  timesRevisited: number
}

export interface AppSettings {
  id: 'main'                    // singleton row
  apiKeyEncrypted: string       // encrypted Gemini key
  parentPinHash: string
  sessionTimeLimit: number      // minutes, default 30
  enabledLanguages: string[]    // e.g. ['en', 'kn', 'hi']
  cameraEnabled: boolean
  onboardingVersion: number
  lastSyncedAt: string          // ISO date string
  chatModel?: string            // Gemini model for chat/reasoning (optional → default)
  visionModel?: string          // Gemini model for camera/vision (optional → default)
}

// Default Gemini models. New fields above are non-indexed, so adding them
// needs NO Dexie version bump — undefined simply falls back to these.
//
// gemini-2.0-flash is DEPRECATED for new users (Google returns 404 "no
// longer available to new users") — live default is 2.5-flash.
// migrateDeprecatedModels() in App.tsx flips any persisted value listed
// in DEPRECATED_MODELS to the new default on app load.
export const DEFAULT_CHAT_MODEL = 'gemini-2.5-flash'
export const DEFAULT_VISION_MODEL = 'gemini-2.5-flash'

/** Models Google has retired for new users — migrate persisted rows away from these. */
export const DEPRECATED_MODELS: ReadonlySet<string> = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-pro-vision',
])

// ─── Dexie database ───────────────────────────────────────────────────────────

class CuriousKidsDB extends Dexie {
  childProfiles!: Table<ChildProfile, string>
  interestTags!: Table<InterestTag, number>
  sessionSummaries!: Table<SessionSummary, string>
  learnedObjects!: Table<LearnedObject, string>
  appSettings!: Table<AppSettings, string>

  constructor() {
    super('CuriousKidsDB')

    // Increment version in Phase 2 when new tables/fields are added; add .upgrade() migration
    this.version(1).stores({
      childProfiles: 'id, googleId, name, lastActiveAt',
      interestTags: '++id, profileId, tag, weight, lastMentioned',
      sessionSummaries: 'id, profileId, date',
      learnedObjects: 'id, profileId, objectName, learnedAt',
      appSettings: 'id'
    })
  }
}

export const db = new CuriousKidsDB()

// ─── Helper utilities ─────────────────────────────────────────────────────────

/** Get the single AppSettings row, or null if not set up yet. */
export async function getAppSettings(): Promise<AppSettings | null> {
  return (await db.appSettings.get('main')) ?? null
}

/** Get the active child profile (first one found by googleId). */
export async function getProfileByGoogleId(googleId: string): Promise<ChildProfile | null> {
  return (await db.childProfiles.where('googleId').equals(googleId).first()) ?? null
}

/** Get top N interest tags for a profile, sorted by weight descending. */
export async function getTopInterests(profileId: string, limit = 5): Promise<InterestTag[]> {
  const tags = await db.interestTags
    .where('profileId')
    .equals(profileId)
    .toArray()
  return tags
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
}

/** Get the last N session summaries for a profile, newest first. */
export async function getRecentSummaries(profileId: string, limit = 7): Promise<SessionSummary[]> {
  const summaries = await db.sessionSummaries
    .where('profileId')
    .equals(profileId)
    .toArray()
  return summaries
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)
}

/**
 * Wraps a DB write operation and swallows QuotaExceededError gracefully.
 * Returns the result on success, or null if quota was exceeded.
 */
export async function safeDbWrite<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof Error && (err.name === 'QuotaExceededError' || err.message.includes('QuotaExceeded'))) {
      console.error('[DB] Storage quota exceeded — skipping write')
      return null
    }
    throw err
  }
}

// Note: an older `upsertInterestTag` helper used to live here. It's been
// superseded by `bumpInterest` in lib/memory.ts (which uses safeDbWrite
// and is the only path used in production). Removed during cleanup.
