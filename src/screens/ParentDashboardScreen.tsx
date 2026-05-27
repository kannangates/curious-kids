import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { db } from '../db/index'
import type { InterestTag, SessionSummary } from '../db/index'
import { useAppStore } from '../store/app'
import { getXPData, type XPData } from '../lib/xp'
import { getRecentUsageMinutes } from '../lib/usage'
import { loadGeminiClient } from '../lib/geminiClient'
import { buildWeeklyReportPrompt } from '../prompts/index'
import { SafeArea } from '../components/SafeArea'

const LANG_LABELS: Record<string, string> = {
  en: 'English', kn: 'Kannada', hi: 'Hindi', ta: 'Tamil', te: 'Telugu'
}

interface WeeklyReport {
  wordsLearned: number
  byLanguage: Record<string, number>
  sessions: number
  minutes: number
  bigDiscovery: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// ─── Level bar colours ─────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  Explorer:   'from-sky-400 to-sky-600',
  Adventurer: 'from-mint-400 to-mint-600',
  Scholar:    'from-lavender-400 to-lavender-600',
  Champion:   'from-leo-400 to-leo-600'
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    })
  } catch {
    return isoString
  }
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    return d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return isoString
  }
}

// ─── Level thresholds (matches xp.ts) ─────────────────────────────────────────

const LEVEL_THRESHOLDS: Record<string, number> = {
  Explorer: 50,
  Adventurer: 150,
  Scholar: 300,
  Champion: Infinity
}

function levelProgress(xpData: XPData): number {
  // Percentage within the current level band
  const thresholds = [0, 50, 150, 300]
  const idx = ['Explorer', 'Adventurer', 'Scholar', 'Champion'].indexOf(xpData.level)
  if (idx < 0) return 0

  const bandStart = thresholds[idx] ?? 0
  const bandEnd = thresholds[idx + 1] ?? xpData.totalXP

  if (bandEnd === Infinity || bandEnd === bandStart) return 100 // Champion

  const progress = (xpData.totalXP - bandStart) / (bandEnd - bandStart)
  return Math.min(100, Math.max(0, Math.round(progress * 100)))
}

// ─── ParentDashboardScreen ────────────────────────────────────────────────────

export function ParentDashboardScreen() {
  const navigate = useNavigate()
  const { profile, googleSub, isOnline } = useAppStore()

  const [xpData, setXpData] = useState<XPData | null>(null)
  const [interests, setInterests] = useState<InterestTag[]>([])
  const [summaries, setSummaries] = useState<SessionSummary[]>([])
  const [learnedCount, setLearnedCount] = useState(0)
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null)
  const [narrative, setNarrative] = useState('')
  const [loadingNarrative, setLoadingNarrative] = useState(false)

  useEffect(() => {
    if (!profile) { setIsLoading(false); return }
    let cancelled = false

    async function load() {
      try {
        // XP
        const xp = await getXPData(profile!.id)

        // Top 5 interests
        const allTags = await db.interestTags
          .where('profileId')
          .equals(profile!.id)
          .toArray()
        const topTags = allTags
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 5)

        // Last 3 session summaries
        const allSummaries = await db.sessionSummaries
          .where('profileId')
          .equals(profile!.id)
          .toArray()
        const recentSummaries = allSummaries
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .slice(0, 3)

        // Learned objects (full list for count + weekly breakdown)
        const allObjects = await db.learnedObjects
          .where('profileId')
          .equals(profile!.id)
          .toArray()

        // Last synced
        const settings = await db.appSettings.get('main')

        // ── Weekly report (last 7 days) ──
        const cutoff = Date.now() - WEEK_MS
        const recentObjects = allObjects.filter(o => new Date(o.learnedAt).getTime() >= cutoff)
        const byLanguage: Record<string, number> = {}
        for (const o of recentObjects) {
          try {
            const t = JSON.parse(o.translations) as Record<string, string>
            for (const code of Object.keys(t)) {
              if (code !== 'en' && t[code]) byLanguage[code] = (byLanguage[code] ?? 0) + 1
            }
          } catch { /* ignore */ }
        }
        const weekSummaries = allSummaries.filter(s => new Date(s.date).getTime() >= cutoff)
        const bigDiscovery =
          weekSummaries.find(s => s.summary)?.summary ??
          (recentObjects[0] ? `Discovered ${recentObjects[0].objectName} ${recentObjects[0].emoji}` : '')
        const report: WeeklyReport = {
          wordsLearned: recentObjects.length,
          byLanguage,
          sessions: weekSummaries.length,
          minutes: getRecentUsageMinutes(profile!.id, 7),
          bigDiscovery
        }

        if (!cancelled) {
          setXpData(xp)
          setInterests(topTags)
          setSummaries(recentSummaries)
          setLearnedCount(allObjects.length)
          setLastSyncedAt(settings?.lastSyncedAt ?? null)
          setWeekly(report)
          setIsLoading(false)
        }
      } catch (err) {
        console.error('[Dashboard] load failed:', err)
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [profile])

  // Optional: turn the weekly stats into a warm sentence via Gemini
  const generateNarrative = useCallback(async () => {
    if (!profile || !googleSub || !weekly) return
    setLoadingNarrative(true)
    try {
      const client = await loadGeminiClient(googleSub)
      const topNames = interests.slice(0, 3).map(t => t.tag)
      const text = await client.streamChat(
        'You write warm one-line summaries for parents.',
        buildWeeklyReportPrompt(profile.name, {
          wordsLearned: weekly.wordsLearned,
          topInterests: topNames,
          sessions: weekly.sessions,
          minutes: weekly.minutes
        }),
        () => { /* no streaming UI */ }
      )
      setNarrative(text.trim())
    } catch {
      setNarrative('')
    } finally {
      setLoadingNarrative(false)
    }
  }, [profile, googleSub, weekly, interests])

  const mascotEmoji =
    profile?.mascotChoice === 'lion' ? '🦁'
    : profile?.mascotChoice === 'owl' ? '🦉'
    : '🐰'

  const INTEREST_COLORS = [
    'bg-lavender-100 text-lavender-700',
    'bg-mint-100 text-mint-700',
    'bg-coral-100 text-coral-700',
    'bg-sky-100 text-sky-700',
    'bg-leo-100 text-leo-700'
  ]

  if (isLoading) {
    return (
      <SafeArea className="bg-lavender-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-lavender-300 border-t-lavender-600 rounded-full animate-spin" />
          <p className="text-lavender-500 font-bold">Loading dashboard...</p>
        </div>
      </SafeArea>
    )
  }

  if (!profile) {
    return (
      <SafeArea className="bg-lavender-50 flex items-center justify-center">
        <div className="text-center px-6">
          <p className="text-xl font-extrabold text-lavender-600 mb-4">No profile found</p>
          <button
            onClick={() => navigate('/onboarding')}
            className="px-6 py-3 bg-lavender-500 text-white font-bold rounded-2xl"
          >
            Set Up Profile
          </button>
        </div>
      </SafeArea>
    )
  }

  const progress = xpData ? levelProgress(xpData) : 0
  const gradientClass = xpData ? (LEVEL_COLORS[xpData.level] ?? 'from-lavender-400 to-lavender-600') : 'from-lavender-400 to-lavender-600'
  const nextLevelName = xpData
    ? Object.keys(LEVEL_THRESHOLDS)[['Explorer', 'Adventurer', 'Scholar', 'Champion'].indexOf(xpData.level) + 1] ?? null
    : null

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-50 to-white overflow-y-auto">
      <div className="flex flex-col flex-1 px-4 py-2 max-w-sm mx-auto w-full gap-4">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90"
            aria-label="Go back to settings"
          >
            ←
          </button>
          <h1 className="text-2xl font-extrabold text-lavender-700 flex-1">
            {profile.name}'s Dashboard 📊
          </h1>
        </div>

        {/* Profile card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl p-5 shadow-sm border border-lavender-100 flex items-center gap-4"
        >
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-leo-300 to-leo-500 flex items-center justify-center text-4xl shadow-lg flex-shrink-0">
            {mascotEmoji}
          </div>
          <div>
            <p className="text-2xl font-extrabold text-gray-800">{profile.name}</p>
            <p className="text-sm text-gray-400 font-medium">
              Age {profile.age} · {profile.preferredLanguages.join(', ').toUpperCase()}
            </p>
            <p className="text-xs text-gray-300 font-medium mt-0.5">
              Joined {formatDate(profile.createdAt)}
            </p>
          </div>
        </motion.div>

        {/* XP / Level card */}
        {xpData && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="bg-white rounded-3xl p-5 shadow-sm border border-lavender-100"
          >
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-3">
              Stars &amp; Level
            </p>

            {/* Level badge */}
            <div className="flex items-center gap-3 mb-4">
              <span className="text-4xl">{xpData.levelEmoji}</span>
              <div>
                <p className="text-xl font-extrabold text-gray-800">{xpData.level}</p>
                <p className="text-sm text-gray-400 font-medium">
                  {xpData.totalXP} XP total
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mb-2">
              <div className="flex justify-between text-xs font-bold text-gray-400 mb-1">
                <span>Progress</span>
                {nextLevelName && xpData.nextLevelXP > 0 && (
                  <span>{xpData.nextLevelXP} XP to {nextLevelName}</span>
                )}
                {xpData.nextLevelXP === 0 && (
                  <span className="text-leo-500">Max Level! 🏆</span>
                )}
              </div>
              <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut', delay: 0.3 }}
                  className={`h-full rounded-full bg-gradient-to-r ${gradientClass}`}
                />
              </div>
              <p className="text-right text-xs text-gray-400 font-bold mt-1">
                {progress}%
              </p>
            </div>
          </motion.div>
        )}

        {/* Stats row */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 gap-3"
        >
          <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 text-center">
            <p className="text-4xl font-extrabold text-lavender-600">{learnedCount}</p>
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wide mt-1">
              Things Learned
            </p>
          </div>
          <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 text-center">
            <p className="text-4xl font-extrabold text-coral-500">{summaries.length > 0 ? summaries.length : 0}</p>
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wide mt-1">
              Sessions
            </p>
          </div>
        </motion.div>

        {/* Weekly report */}
        {weekly && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="bg-white rounded-3xl p-5 shadow-sm border border-mint-200"
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">📊 This Week</p>
              <span className="text-xs font-bold text-mint-600 bg-mint-50 px-2 py-0.5 rounded-full">last 7 days</span>
            </div>

            {/* Narrative line */}
            {narrative ? (
              <p className="text-sm text-gray-700 font-semibold leading-relaxed mb-3 italic">"{narrative}"</p>
            ) : (
              <button
                onClick={() => void generateNarrative()}
                disabled={loadingNarrative || !isOnline}
                className="text-sm font-bold text-mint-600 underline underline-offset-2 mb-3 disabled:opacity-50"
              >
                {loadingNarrative ? 'Writing summary…' : isOnline ? '✨ Write a friendly summary' : 'Summary needs internet'}
              </button>
            )}

            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="bg-mint-50 rounded-2xl py-3 text-center">
                <p className="text-2xl font-extrabold text-mint-700">{weekly.wordsLearned}</p>
                <p className="text-[10px] text-gray-400 font-bold uppercase">Words</p>
              </div>
              <div className="bg-lavender-50 rounded-2xl py-3 text-center">
                <p className="text-2xl font-extrabold text-lavender-700">{weekly.sessions}</p>
                <p className="text-[10px] text-gray-400 font-bold uppercase">Sessions</p>
              </div>
              <div className="bg-coral-50 rounded-2xl py-3 text-center">
                <p className="text-2xl font-extrabold text-coral-600">{weekly.minutes}</p>
                <p className="text-[10px] text-gray-400 font-bold uppercase">Minutes</p>
              </div>
            </div>

            {/* By language */}
            {Object.keys(weekly.byLanguage).length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {Object.entries(weekly.byLanguage).map(([code, n]) => (
                  <span key={code} className="text-xs font-bold px-2.5 py-1 rounded-full bg-sky-100 text-sky-700">
                    {LANG_LABELS[code] ?? code}: {n}
                  </span>
                ))}
              </div>
            )}

            {/* Big discovery */}
            {weekly.bigDiscovery && (
              <div className="bg-leo-50 rounded-2xl px-3 py-2">
                <p className="text-[10px] text-leo-500 font-extrabold uppercase tracking-wide">🌟 Highlight</p>
                <p className="text-sm text-gray-700 font-medium">{weekly.bigDiscovery}</p>
              </div>
            )}

            {weekly.wordsLearned === 0 && weekly.sessions === 0 && (
              <p className="text-sm text-gray-400 font-medium text-center py-2">
                No activity yet this week — encourage {profile.name} to explore with Leo! 🦁
              </p>
            )}
          </motion.div>
        )}

        {/* Top interests */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-white rounded-3xl p-5 shadow-sm border border-lavender-100"
        >
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-3">
            Top Interests
          </p>
          {interests.length === 0 ? (
            <p className="text-sm text-gray-400 font-medium">
              No interests recorded yet — start exploring! 🚀
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {interests.map((tag, idx) => (
                <span
                  key={tag.id ?? tag.tag}
                  className={`
                    px-3 py-1.5 rounded-full text-sm font-extrabold capitalize
                    ${INTEREST_COLORS[idx % INTEREST_COLORS.length]}
                  `}
                >
                  {tag.tag}
                  <span className="ml-1 opacity-60 text-xs font-bold">
                    {Math.round(tag.weight * 10) / 10}
                  </span>
                </span>
              ))}
            </div>
          )}
        </motion.div>

        {/* Recent sessions */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-3xl p-5 shadow-sm border border-lavender-100"
        >
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-3">
            Recent Sessions
          </p>
          {summaries.length === 0 ? (
            <p className="text-sm text-gray-400 font-medium">
              No sessions yet — let {profile.name} start chatting with Leo! 🦁
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {summaries.map(session => (
                <div
                  key={session.id}
                  className="bg-lavender-50 rounded-2xl px-4 py-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-extrabold text-lavender-500 uppercase tracking-wide">
                      {formatDate(session.date)}
                    </p>
                    {session.topicsExplored.length > 0 && (
                      <span className="text-xs text-gray-400 font-medium">
                        {session.topicsExplored.length} topics
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-700 font-medium leading-relaxed">
                    {session.summary}
                  </p>
                  {session.emotionalNote && (
                    <p className="text-xs text-lavender-500 font-semibold mt-1 italic">
                      {session.emotionalNote}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Last synced */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex items-center justify-between"
        >
          <div>
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">
              Last Backed Up
            </p>
            <p className="text-sm font-bold text-gray-600 mt-0.5">
              {lastSyncedAt
                ? formatDateTime(lastSyncedAt)
                : 'Never synced'}
            </p>
          </div>
          <span className="text-2xl">☁️</span>
        </motion.div>

        {/* Quick links */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="flex gap-3"
        >
          <button
            onClick={() => navigate('/discoveries')}
            className="flex-1 py-3 bg-gradient-to-r from-mint-400 to-mint-600 text-white font-extrabold rounded-2xl shadow-md active:scale-95"
          >
            ⭐ Discoveries
          </button>
          <button
            onClick={() => navigate('/settings')}
            className="flex-1 py-3 bg-gradient-to-r from-lavender-400 to-lavender-600 text-white font-extrabold rounded-2xl shadow-md active:scale-95"
          >
            ⚙️ Settings
          </button>
        </motion.div>

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>
    </SafeArea>
  )
}
