import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { db } from '../db/index'
import type { LearnedObject } from '../db/index'
import { useAppStore } from '../store/app'
import { addXP } from '../lib/xp'
import { speak, stopSpeaking } from '../lib/voice'
import { playTap, playOops } from '../lib/audio'
import { XPCelebration } from '../components/XPCelebration'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

const LANG_NAMES: Record<string, string> = {
  kn: 'Kannada', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', en: 'English'
}

interface Round {
  objectName: string
  emoji: string
  options: string[]
  correctIndex: number
  langName: string
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

/** Parse an object's translations JSON safely. */
function parseTranslations(o: LearnedObject): Record<string, string> {
  try { return JSON.parse(o.translations) as Record<string, string> } catch { return {} }
}

export function WordGameScreen() {
  const navigate = useNavigate()
  const { profile } = useAppStore()

  const [pool, setPool] = useState<LearnedObject[]>([])
  const [targetLang, setTargetLang] = useState<string>('')
  const [round, setRound] = useState<Round | null>(null)
  const [answered, setAnswered] = useState<number | null>(null)
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)

  const [xpVisible, setXpVisible] = useState(false)
  const [xpGained, setXpGained] = useState(0)
  const [xpLevelUp, setXpLevelUp] = useState('')

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false; stopSpeaking() }
  }, [])

  // Build a round from the pool for a given target language
  const buildRound = useCallback((items: LearnedObject[], lang: string): Round | null => {
    const withT = items
      .map(o => ({ o, t: parseTranslations(o) }))
      .filter(x => typeof x.t[lang] === 'string' && x.t[lang].length > 0)
    if (withT.length < 3) return null

    const correct = withT[Math.floor(Math.random() * withT.length)]
    const correctVal = correct.t[lang]
    const distractors = shuffle(
      withT.filter(x => x.t[lang] !== correctVal).map(x => x.t[lang])
    ).slice(0, 2)
    const options = shuffle([correctVal, ...distractors])

    return {
      objectName: correct.o.objectName,
      emoji: correct.o.emoji || '🌍',
      options,
      correctIndex: options.indexOf(correctVal),
      langName: LANG_NAMES[lang] ?? lang
    }
  }, [])

  // Load words + pick a target language that has enough translations
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!profile) { setLoading(false); return }
      try {
        const items = await db.learnedObjects.where('profileId').equals(profile.id).toArray()
        // Prefer a non-English language the child has, that has >= 3 translated words
        const candidateLangs = [
          ...profile.preferredLanguages.filter(l => l !== 'en'),
          'kn', 'hi', 'ta', 'te'
        ]
        let chosen = ''
        for (const l of candidateLangs) {
          const count = items.filter(o => {
            const t = parseTranslations(o)
            return typeof t[l] === 'string' && t[l].length > 0
          }).length
          if (count >= 3) { chosen = l; break }
        }
        if (cancelled) return
        setPool(items)
        setTargetLang(chosen)
        setRound(chosen ? buildRound(items, chosen) : null)
        setLoading(false)
      } catch (err) {
        console.error('[WordGame] load failed:', err)
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [profile, buildRound])

  const handleAnswer = useCallback(async (idx: number) => {
    if (!round || answered !== null) return
    setAnswered(idx)
    const correct = idx === round.correctIndex
    // Speak the correct translation either way (reinforcement)
    void speak(round.options[round.correctIndex], targetLang)

    if (correct) {
      playTap()
      setScore(s => s + 1)
      setStreak(s => s + 1)
      if (profile) {
        try {
          const xp = await addXP(profile.id, 'quiz_correct')
          if (isMountedRef.current) {
            setXpGained(xp.gained)
            setXpLevelUp(xp.current.level !== xp.previous.level
              ? `You're now a ${xp.current.level}! ${xp.current.levelEmoji}` : '')
            setXpVisible(true)
          }
        } catch { /* non-fatal */ }
      }
    } else {
      playOops()
      setStreak(0)
    }
  }, [round, answered, targetLang, profile])

  const nextRound = useCallback(() => {
    setAnswered(null)
    setRound(targetLang ? buildRound(pool, targetLang) : null)
  }, [pool, targetLang, buildRound])

  // ── Render ─────────────────────────────────────────────────────────────────

  const notEnough = !loading && !round

  return (
    <SafeArea className="bg-gradient-to-br from-coral-100 via-leo-50 to-mint-100 overflow-hidden">
      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-coral-100">
          <button
            onClick={() => { stopSpeaking(); navigate('/') }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-coral-100 active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <h1 className="font-extrabold text-coral-700 text-lg flex-1">🎮 Word Match</h1>
          {round && (
            <span className="text-sm font-extrabold text-coral-600 bg-coral-50 px-3 py-1 rounded-full">
              ⭐ {score}
            </span>
          )}
        </div>

        {loading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <LeoMascot size="md" mood="thinking" />
            <p className="text-sm font-bold text-coral-500 animate-pulse">Setting up the game…</p>
          </div>
        )}

        {/* Empty state */}
        {notEnough && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <LeoMascot size="lg" mood="happy" />
            <p className="text-lg font-extrabold text-coral-600">Let's learn a few words first!</p>
            <p className="text-sm text-gray-500 font-medium max-w-[240px]">
              Play this game after learning at least 3 words. Try Word Explorer or the camera!
            </p>
            <div className="flex gap-3">
              <button onClick={() => navigate('/words')} className="px-5 py-3 bg-coral-500 text-white font-extrabold rounded-2xl active:scale-95">📚 Word Explorer</button>
              <button onClick={() => navigate('/camera')} className="px-5 py-3 bg-sky-500 text-white font-extrabold rounded-2xl active:scale-95">📷 Camera</button>
            </div>
          </div>
        )}

        {/* Round */}
        {round && (
          <div className="flex-1 flex flex-col px-5 py-4">
            {streak >= 2 && answered === null && (
              <motion.p
                initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                className="text-center text-sm font-extrabold text-leo-600 mb-1"
              >
                🔥 {streak} in a row!
              </motion.p>
            )}

            <div className="bg-white rounded-3xl p-6 shadow-md text-center mb-5">
              <div className="text-6xl mb-2">{round.emoji}</div>
              <p className="text-sm font-bold text-gray-400">How do you say</p>
              <p className="text-3xl font-extrabold text-gray-800 capitalize my-1">{round.objectName}</p>
              <p className="text-sm font-bold text-gray-400">in <span className="text-coral-600">{round.langName}</span>?</p>
            </div>

            <div className="flex flex-col gap-3">
              {round.options.map((opt, idx) => {
                let cls = 'w-full py-4 px-4 rounded-2xl font-extrabold text-xl border-2 transition-all active:scale-95 '
                if (answered === null) {
                  cls += 'bg-white border-coral-200 text-gray-700'
                } else if (idx === round.correctIndex) {
                  cls += 'bg-mint-400 border-mint-500 text-white'
                } else if (idx === answered) {
                  cls += 'bg-coral-200 border-coral-400 text-coral-800'
                } else {
                  cls += 'bg-gray-100 border-gray-200 text-gray-400'
                }
                return (
                  <button key={idx} onClick={() => void handleAnswer(idx)} disabled={answered !== null} className={cls}>
                    {opt}
                  </button>
                )
              })}
            </div>

            <AnimatePresence>
              {answered !== null && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="mt-5 flex flex-col items-center gap-3"
                >
                  <p className={`font-extrabold text-lg ${answered === round.correctIndex ? 'text-mint-600' : 'text-coral-600'}`}>
                    {answered === round.correctIndex ? 'Yay! That\'s right! 🎉' : `It's "${round.options[round.correctIndex]}"! 💪`}
                  </p>
                  <button
                    onClick={nextRound}
                    className="w-full py-4 bg-gradient-to-r from-coral-400 to-coral-600 text-white font-extrabold text-lg rounded-3xl shadow-lg active:scale-95"
                  >
                    Next word →
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      <XPCelebration visible={xpVisible} gained={xpGained} levelUpLabel={xpLevelUp} onDismiss={() => setXpVisible(false)} />
    </SafeArea>
  )
}
