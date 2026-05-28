import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { useAppStore } from '../store/app'
import { loadGeminiClient, NoApiKeyError } from '../lib/geminiClient'
import { getTopInterests } from '../lib/memory'
import { db } from '../db/index'
import { speakSlow, stopSpeaking, pauseSpeaking, resumeSpeaking } from '../lib/voice'
import { buildBedtimeStoryPrompt } from '../prompts/index'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

type Phase = 'loading' | 'ready' | 'error'

// A scattering of stars for the night-sky backdrop
const STARS = Array.from({ length: 28 }, (_, i) => ({
  id: i,
  top: Math.random() * 100,
  left: Math.random() * 100,
  size: 1 + Math.random() * 2.5,
  delay: Math.random() * 3
}))

export function BedtimeStoryScreen() {
  const navigate = useNavigate()
  const { profile, googleSub, isOnline } = useAppStore()
  const lang = profile?.preferredLanguages[0] ?? 'en'

  const [phase, setPhase] = useState<Phase>('loading')
  const [story, setStory] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [isReading, setIsReading] = useState(false)
  const [isPaused, setIsPaused] = useState(false)

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      stopSpeaking()
    }
  }, [])

  const generate = useCallback(async () => {
    if (!profile || !googleSub) return
    stopSpeaking()
    setIsReading(false)
    setIsPaused(false)
    setPhase('loading')
    setStory('')
    setErrorMsg('')

    if (!isOnline) {
      setErrorMsg("Leo needs the internet to dream up a brand-new story. Let's try again when we're connected! 🌙")
      setPhase('error')
      return
    }

    try {
      const client = await loadGeminiClient(googleSub)
      const interests = (await getTopInterests(profile.id, 2)).map(t => t.tag)
      const learned = await db.learnedObjects
        .where('profileId').equals(profile.id).toArray()
      const learnedWords = learned
        .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
        .slice(0, 5)
        .map(o => o.objectName)

      const prompt = buildBedtimeStoryPrompt(profile.name, profile.age, interests, learnedWords)
      let text = ''
      await client.streamChat(
        'You are a gentle storyteller for children. Write only the story.',
        prompt,
        (chunk) => {
          text += chunk
          if (isMountedRef.current) setStory(text)
        }
      )
      if (!isMountedRef.current) return
      setStory(text.trim())
      setPhase('ready')
    } catch (err) {
      if (!isMountedRef.current) return
      if (err instanceof NoApiKeyError) {
        setErrorMsg('Ask a parent to set up the magic key in Settings first. ⚙️')
      } else {
        setErrorMsg("Leo's story dust ran out for a moment. Let's try again! 🌙")
      }
      setPhase('error')
    }
  }, [profile, googleSub, isOnline])

  useEffect(() => {
    void generate()
  }, [generate])

  // ── Read aloud controls ────────────────────────────────────────────────────

  const handleRead = useCallback(() => {
    if (!story) return
    setIsReading(true)
    setIsPaused(false)
    speakSlow(story, lang)
      .then(() => { if (isMountedRef.current) { setIsReading(false); setIsPaused(false) } })
      .catch(() => { if (isMountedRef.current) { setIsReading(false); setIsPaused(false) } })
  }, [story, lang])

  const handlePauseResume = useCallback(() => {
    if (isPaused) {
      resumeSpeaking()
      setIsPaused(false)
    } else {
      pauseSpeaking()
      setIsPaused(true)
    }
  }, [isPaused])

  const handleStop = useCallback(() => {
    stopSpeaking()
    setIsReading(false)
    setIsPaused(false)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeArea className="bg-gradient-to-b from-[#1b1740] via-[#2a2456] to-[#3a2f6e] overflow-hidden">
      {/* Starfield */}
      <div className="absolute inset-0 pointer-events-none">
        {STARS.map(s => (
          <motion.span
            key={s.id}
            className="absolute rounded-full bg-white"
            style={{ top: `${s.top}%`, left: `${s.left}%`, width: s.size, height: s.size }}
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 2.5, delay: s.delay, repeat: Infinity }}
          />
        ))}
        <span className="absolute top-10 right-8 text-5xl">🌙</span>
      </div>

      <div className="relative flex flex-col flex-1 max-w-sm mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={() => { stopSpeaking(); navigate('/') }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-white/15 text-white active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <h1 className="font-extrabold text-white text-lg flex-1">🌙 Bedtime Story</h1>
        </div>

        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center">
            <motion.div animate={{ y: [0, -8, 0] }} transition={{ duration: 2, repeat: Infinity }}>
              <LeoMascot size="lg" mood="sleeping" />
            </motion.div>
            <p className="text-lg font-bold text-white/90">
              {story ? 'Once upon a time…' : `Leo is dreaming up a story for ${profile?.name ?? 'you'}…`}
            </p>
            {story && (
              <p className="text-sm text-white/70 font-medium leading-relaxed max-h-40 overflow-y-auto px-2">
                {story}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center">
            <LeoMascot size="lg" mood="sleeping" />
            <p className="text-base font-semibold text-white/90 leading-relaxed">{errorMsg}</p>
            <div className="flex gap-3">
              <button
                onClick={() => void generate()}
                className="px-6 py-3 bg-white/20 text-white font-extrabold rounded-2xl active:scale-95"
              >
                Try again 🌟
              </button>
              <button
                onClick={() => navigate('/')}
                className="px-6 py-3 bg-white/10 text-white/80 font-bold rounded-2xl active:scale-95"
              >
                Back home
              </button>
            </div>
          </div>
        )}

        {/* Story ready */}
        {phase === 'ready' && (
          <>
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white/10 backdrop-blur-sm rounded-3xl p-5 mt-2"
              >
                <p className="text-[17px] leading-[1.9] text-white/95 font-medium whitespace-pre-line">
                  {story}
                </p>
              </motion.div>
            </div>

            {/* Controls */}
            <div className="px-5 pb-safe pt-3 flex items-center justify-center gap-3 bg-black/20 backdrop-blur-sm">
              {!isReading ? (
                <button
                  onClick={handleRead}
                  className="flex-1 py-4 bg-gradient-to-r from-lavender-400 to-lavender-600 text-white font-extrabold text-lg rounded-3xl shadow-lg active:scale-95"
                >
                  ▶ Read to me
                </button>
              ) : (
                <>
                  <button
                    onClick={handlePauseResume}
                    className="flex-1 py-4 bg-white/20 text-white font-extrabold text-lg rounded-3xl active:scale-95"
                  >
                    {isPaused ? '▶ Resume' : '⏸ Pause'}
                  </button>
                  <button
                    onClick={handleStop}
                    className="px-5 py-4 bg-white/10 text-white/80 font-bold rounded-3xl active:scale-95"
                    aria-label="Stop"
                  >
                    ⏹
                  </button>
                </>
              )}
              <button
                onClick={() => void generate()}
                className="px-5 py-4 bg-white/10 text-white/80 font-bold rounded-3xl active:scale-95"
                aria-label="New story"
              >
                🔄
              </button>
            </div>
          </>
        )}
      </div>
    </SafeArea>
  )
}
