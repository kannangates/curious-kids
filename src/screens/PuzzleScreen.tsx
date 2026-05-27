import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { db } from '../db/index'
import type { LearnedObject } from '../db/index'
import { useAppStore } from '../store/app'
import { loadGeminiClient } from '../lib/geminiClient'
import type { GeminiClient } from '../lib/gemini'
import { addXP } from '../lib/xp'
import { speak, stopSpeaking } from '../lib/voice'
import { playTap, playOops } from '../lib/audio'
import { buildPuzzleHintPrompt } from '../prompts/index'
import { checkOutput } from '../lib/safety'
import { XPCelebration } from '../components/XPCelebration'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

interface Round {
  answer: LearnedObject
  options: LearnedObject[]   // 3 options including the answer
  riddle: string
  fromAI: boolean            // true if riddle came from Gemini, false = offline emoji clue
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export function PuzzleScreen() {
  const navigate = useNavigate()
  const { profile, googleSub, isOnline } = useAppStore()
  const lang = profile?.preferredLanguages[0] ?? 'en'

  const [pool, setPool] = useState<LearnedObject[]>([])
  const [round, setRound] = useState<Round | null>(null)
  const [answeredId, setAnsweredId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [score, setScore] = useState(0)

  const [xpVisible, setXpVisible] = useState(false)
  const [xpGained, setXpGained] = useState(0)
  const [xpLevelUp, setXpLevelUp] = useState('')

  const isMountedRef = useRef(true)
  const clientRef = useRef<GeminiClient | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false; stopSpeaking() }
  }, [])

  const makeRound = useCallback(async (items: LearnedObject[]) => {
    if (items.length < 3) return
    setGenerating(true)
    setAnsweredId(null)

    const answer = items[Math.floor(Math.random() * items.length)]
    const distractors = shuffle(items.filter(o => o.id !== answer.id)).slice(0, 2)
    const options = shuffle([answer, ...distractors])

    let riddle = ''
    let fromAI = false
    if (isOnline && clientRef.current) {
      try {
        const raw = await clientRef.current.streamChat(
          'You write short, fun riddles for children. Output only the riddle.',
          buildPuzzleHintPrompt(answer.objectName, profile?.age ?? 5),
          () => { /* no streaming UI */ }
        )
        const cleaned = raw.trim()
        if (cleaned && checkOutput(cleaned)) { riddle = cleaned; fromAI = true }
      } catch {
        // fall through to offline clue
      }
    }
    if (!riddle) {
      riddle = `Leo is thinking of something you learned about… ${answer.emoji}\nCan you guess which one?`
    }

    if (!isMountedRef.current) return
    setRound({ answer, options, riddle, fromAI })
    setGenerating(false)
    // Read the riddle aloud
    void speak(riddle.replace(/\n/g, ' '), lang)
  }, [isOnline, profile, lang])

  // Initial load
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!profile) { setLoading(false); return }
      try {
        if (googleSub) {
          try { clientRef.current = await loadGeminiClient(googleSub) } catch { clientRef.current = null }
        }
        const items = await db.learnedObjects.where('profileId').equals(profile.id).toArray()
        if (cancelled) return
        setPool(items)
        setLoading(false)
        if (items.length >= 3) await makeRound(items)
      } catch (err) {
        console.error('[Puzzle] load failed:', err)
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [profile, googleSub, makeRound])

  const handleGuess = useCallback(async (obj: LearnedObject) => {
    if (!round || answeredId !== null) return
    setAnsweredId(obj.id)
    const correct = obj.id === round.answer.id
    if (correct) {
      playTap()
      void speak(`Yes! It's a ${round.answer.objectName}!`, lang)
      setScore(s => s + 1)
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
      void speak(`Ooh, it was the ${round.answer.objectName}!`, lang)
    }
  }, [round, answeredId, profile, lang])

  const notEnough = !loading && pool.length < 3

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-100 via-sky-50 to-mint-100 overflow-hidden">
      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-lavender-100">
          <button
            onClick={() => { stopSpeaking(); navigate('/') }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <h1 className="font-extrabold text-lavender-700 text-lg flex-1">🧩 Puzzle Time</h1>
          {round && (
            <span className="text-sm font-extrabold text-lavender-600 bg-lavender-50 px-3 py-1 rounded-full">⭐ {score}</span>
          )}
          {!isOnline && (
            <span className="text-xs font-bold text-orange-500 bg-orange-50 px-2 py-1 rounded-full">Offline</span>
          )}
        </div>

        {loading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <LeoMascot size="md" mood="thinking" />
            <p className="text-sm font-bold text-lavender-500 animate-pulse">Loading puzzles…</p>
          </div>
        )}

        {notEnough && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <LeoMascot size="lg" mood="happy" />
            <p className="text-lg font-extrabold text-lavender-600">Discover a few things first!</p>
            <p className="text-sm text-gray-500 font-medium max-w-[240px]">
              Puzzle Time needs at least 3 discoveries. Point the camera at things or chat with Leo!
            </p>
            <div className="flex gap-3">
              <button onClick={() => navigate('/camera')} className="px-5 py-3 bg-sky-500 text-white font-extrabold rounded-2xl active:scale-95">📷 Camera</button>
              <button onClick={() => navigate('/chat')} className="px-5 py-3 bg-lavender-500 text-white font-extrabold rounded-2xl active:scale-95">🎙️ Chat</button>
            </div>
          </div>
        )}

        {!loading && pool.length >= 3 && (
          <div className="flex-1 flex flex-col px-5 py-4">
            {/* Riddle card */}
            <div className="bg-white rounded-3xl p-5 shadow-md mb-5 flex items-start gap-3">
              <div className="flex-shrink-0"><LeoMascot size="sm" mood={generating ? 'thinking' : 'excited'} /></div>
              <div className="flex-1">
                {generating ? (
                  <p className="text-sm font-bold text-lavender-400 animate-pulse">Leo is thinking of a riddle…</p>
                ) : (
                  <p className="text-base font-bold text-gray-700 leading-relaxed whitespace-pre-line">{round?.riddle}</p>
                )}
              </div>
              {round && !generating && (
                <button
                  onClick={() => round && speak(round.riddle.replace(/\n/g, ' '), lang)}
                  className="w-9 h-9 flex items-center justify-center bg-lavender-100 rounded-full text-lg active:scale-90 flex-shrink-0"
                  aria-label="Hear the riddle again"
                >🔊</button>
              )}
            </div>

            {/* Options */}
            {round && !generating && (
              <div className="grid grid-cols-3 gap-3">
                {round.options.map(opt => {
                  const isAnswer = opt.id === round.answer.id
                  const isPicked = opt.id === answeredId
                  let cls = 'flex flex-col items-center gap-1 rounded-3xl p-3 border-2 transition-all active:scale-95 min-h-[96px] justify-center '
                  if (answeredId === null) cls += 'bg-white border-lavender-100'
                  else if (isAnswer) cls += 'bg-mint-400 border-mint-500 text-white'
                  else if (isPicked) cls += 'bg-coral-200 border-coral-400'
                  else cls += 'bg-gray-100 border-gray-200 opacity-60'
                  return (
                    <button key={opt.id} onClick={() => void handleGuess(opt)} disabled={answeredId !== null} className={cls}>
                      <span className="text-4xl">{opt.emoji || '❓'}</span>
                      {answeredId !== null && (
                        <span className="text-xs font-extrabold capitalize leading-tight text-center">{opt.objectName}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Result + next */}
            <AnimatePresence>
              {answeredId !== null && round && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="mt-6 flex flex-col items-center gap-3"
                >
                  <p className={`font-extrabold text-lg ${answeredId === round.answer.id ? 'text-mint-600' : 'text-coral-600'}`}>
                    {answeredId === round.answer.id ? 'You solved it! 🎉' : `It was the ${round.answer.objectName}!`}
                  </p>
                  <button
                    onClick={() => void makeRound(pool)}
                    className="w-full py-4 bg-gradient-to-r from-lavender-500 to-lavender-700 text-white font-extrabold text-lg rounded-3xl shadow-lg active:scale-95"
                  >
                    Next puzzle →
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
