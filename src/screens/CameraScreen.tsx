import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { db, safeDbWrite } from '../db/index'
import type { LearnedObject } from '../db/index'
import { useAppStore } from '../store/app'
import { decryptApiKey } from '../lib/crypto'
import { createGeminiClient, ApiKeyError, type GeminiClient } from '../lib/gemini'
import { checkOutput } from '../lib/safety'
import { bumpInterest } from '../lib/memory'
import { buildCameraPrompt } from '../prompts/index'
import { addXP } from '../lib/xp'
import { playTap, playOops } from '../lib/audio'
import { XPCelebration } from '../components/XPCelebration'
import { SafeArea } from '../components/SafeArea'

// ─── Types ────────────────────────────────────────────────────────────────────

interface VisionResult {
  objectName: string
  emoji: string
  funFact: string
  translations: Record<string, string>
}

type QuizQuestion = {
  text: string
  options: string[]
  correctIndex: number
}

type ScreenPhase =
  | 'consent'
  | 'camera'
  | 'loading'
  | 'result'
  | 'error'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONSENT_KEY = (profileId: string) => `ck_camera_consent_${profileId}`

function hasConsent(profileId: string): boolean {
  return localStorage.getItem(CONSENT_KEY(profileId)) === 'true'
}

function grantConsent(profileId: string): void {
  localStorage.setItem(CONSENT_KEY(profileId), 'true')
}

/** Release all tracks on a MediaStream */
function releaseStream(stream: MediaStream | null): void {
  if (!stream) return
  stream.getTracks().forEach(track => track.stop())
}

/** Build a simple multiple-choice quiz from the result */
function buildQuiz(result: VisionResult, langs: string[]): QuizQuestion {
  // Validate inputs
  if (!result.objectName || result.objectName.length === 0) {
    throw new Error('Invalid result: missing objectName')
  }
  if (!langs || langs.length === 0) {
    throw new Error('Invalid languages: empty array')
  }
  
  const name = result.objectName
  const firstLetter = name.charAt(0).toUpperCase()

  // Prefer translation quiz if there is a non-English language
  const nonEnLangs = langs.filter(l => l !== 'en')
  if (nonEnLangs.length > 0 && result.translations && Object.keys(result.translations).length > 0) {
    const targetLang = nonEnLangs[0]
    const correctAnswer = result.translations[targetLang] ?? name
    
    // Validate we have a translation
    if (correctAnswer && correctAnswer.length > 0) {
      const LANG_NAMES: Record<string, string> = {
        kn: 'Kannada', hi: 'Hindi', ta: 'Tamil', te: 'Telugu'
      }
      const langName = LANG_NAMES[targetLang] ?? targetLang

      // Generic distractors — wrong-sounding made-up words
      const distractors = ['सनी', 'ಮರ', 'पानी'].filter(d => d !== correctAnswer).slice(0, 2)
      // Fill up to 2 distractors if needed
      const fallbacks = ['Neel', 'Tara', 'Mira', 'Balu', 'Ravi']
      let distIdx = 0
      while (distractors.length < 2) {
        const fb = fallbacks[distIdx++ % fallbacks.length]
        if (fb !== correctAnswer && !distractors.includes(fb)) distractors.push(fb)
      }

      const options = [correctAnswer, distractors[0], distractors[1]]
      // Shuffle options and track correct index
      const shuffled = [...options].sort(() => Math.random() - 0.5)
      const correctIndex = shuffled.indexOf(correctAnswer)

      return {
        text: `How do you say "${name}" in ${langName}?`,
        options: shuffled,
        correctIndex
      }
    }
  }

  // Fallback: first-letter quiz
  const COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Pink', 'Purple', 'White', 'Black', 'Brown']
  const otherColors = COLORS.filter(c => c.charAt(0).toUpperCase() !== firstLetter)
  const distractor1 = otherColors[Math.floor(Math.random() * otherColors.length)]
  const distractor2 = otherColors.filter(c => c !== distractor1)[Math.floor(Math.random() * (otherColors.length - 1))]
  const correctAnswer = firstLetter

  const rawOptions = [correctAnswer, distractor1.charAt(0), distractor2.charAt(0)]
  const unique = [...new Set(rawOptions)]
  while (unique.length < 3) {
    const extra = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(
      c => !unique.includes(c) && c !== firstLetter
    )
    if (extra) unique.push(extra)
  }
  const shuffled = unique.sort(() => Math.random() - 0.5)
  const correctIndex = shuffled.indexOf(correctAnswer)

  return {
    text: `Can you find the first letter of "${name}"?`,
    options: shuffled,
    correctIndex
  }
}

// ─── CameraScreen ─────────────────────────────────────────────────────────────

export function CameraScreen() {
  const navigate = useNavigate()
  const { profile, googleSub, isOnline } = useAppStore()

  const [phase, setPhase] = useState<ScreenPhase>('consent')
  const [errorMsg, setErrorMsg] = useState('')
  const [result, setResult] = useState<VisionResult | null>(null)
  const [quiz, setQuiz] = useState<QuizQuestion | null>(null)
  const [quizAnswered, setQuizAnswered] = useState<'correct' | 'wrong' | null>(null)
  const [quizSkipped, setQuizSkipped] = useState(false)
  const [geminiClient, setGeminiClient] = useState<GeminiClient | null>(null)
  const [clientError, setClientError] = useState<string | null>(null)
  const [cameraOff, setCameraOff] = useState(false)

  // XP celebration state
  const [xpVisible, setXpVisible] = useState(false)
  const [xpGained, setXpGained] = useState(0)
  const [xpLevelUp, setXpLevelUp] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      releaseStream(streamRef.current)
      streamRef.current = null
    }
  }, [])

  // ── Attach stream to <video> once it's rendered ───────────────────────────
  // getUserMedia may resolve before React mounts the <video> element, leaving
  // videoRef.current null at attach time. This effect re-attaches when the
  // camera phase renders, guaranteeing the live feed is shown.
  useEffect(() => {
    if (phase === 'camera' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [phase])

  // ── Init Gemini client ────────────────────────────────────────────────────

  useEffect(() => {
    if (!profile || !googleSub) return
    let cancelled = false

    async function init() {
      try {
        const settings = await db.appSettings.get('main')
        if (!settings?.apiKeyEncrypted) {
          if (!cancelled && isMountedRef.current) {
            setClientError('Ask a parent to set up the magic key first! ⚙️')
          }
          return
        }
        const apiKey = await decryptApiKey(settings.apiKeyEncrypted, googleSub!)
        if (cancelled || !isMountedRef.current) return
        setGeminiClient(createGeminiClient(apiKey, {
          chatModel: settings.chatModel,
          visionModel: settings.visionModel
        }))
      } catch (err) {
        if (!cancelled && isMountedRef.current) {
          setClientError(
            err instanceof DOMException || (err instanceof Error && err.message.includes('decrypt'))
              ? 'Sign-in mismatch — please ask a parent to re-enter the API key.'
              : 'Could not load the magic key. Please check settings.'
          )
        }
      }
    }

    void init()
    return () => { cancelled = true }
  }, [profile, googleSub])

  // ── Start the camera ──────────────────────────────────────────────────────

  const startCamera = useCallback(async (retry = false) => {
    if (!isMountedRef.current) return
    setPhase('camera')
    setErrorMsg('')

    const constraints: MediaStreamConstraints = retry
      ? { video: true }
      : { video: { facingMode: 'environment' } }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (!isMountedRef.current) {
        releaseStream(stream)
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
    } catch (err) {
      if (!isMountedRef.current) return
      const name = (err as Error)?.name ?? ''
      if (name === 'OverconstrainedError' && !retry) {
        // Retry without facingMode constraint
        void startCamera(true)
        return
      }
      if (name === 'NotAllowedError') {
        setErrorMsg("Leo can't see without camera access! Ask a parent to allow the camera in browser settings. 📷")
      } else if (name === 'NotFoundError') {
        setErrorMsg('No camera found on this device!')
      } else {
        setErrorMsg(`Camera error: ${(err as Error)?.message ?? 'Unknown error'}`)
      }
      // Ensure stream is cleaned up on error
      releaseStream(streamRef.current)
      streamRef.current = null
      setPhase('error')
    }
  }, [])

  // ── Handle consent ────────────────────────────────────────────────────────

  const handleConsent = useCallback(() => {
    if (!profile) return
    grantConsent(profile.id)
    void startCamera()
  }, [profile, startCamera])

  // ── Respect parent camera toggle, then check consent / auto-start ───────
  useEffect(() => {
    if (!profile) return
    let cancelled = false
    async function init() {
      try {
        const s = await db.appSettings.get('main')
        if (cancelled) return
        if (s && s.cameraEnabled === false) {
          setCameraOff(true)
          return // do NOT start the camera when disabled
        }
      } catch { /* ignore — default to enabled */ }
      if (cancelled) return
      if (profile && hasConsent(profile.id)) void startCamera()
      // else stay on consent phase
    }
    void init()
    return () => { cancelled = true }
  }, [profile, startCamera])

  // ── Capture photo ──────────────────────────────────────────────────────

  const handleCapture = useCallback(async () => {
    if (!isMountedRef.current || !videoRef.current || !canvasRef.current) return
    if (!isOnline) {
      setErrorMsg('Leo needs internet to identify things! Come back when connected 🌐')
      releaseStream(streamRef.current)
      streamRef.current = null
      setPhase('error')
      return
    }
    if (!geminiClient) {
      setErrorMsg(clientError ?? 'Leo is not ready yet — please wait a moment!')
      releaseStream(streamRef.current)
      streamRef.current = null
      setPhase('error')
      return
    }

    // Pause the feed visually. Cap the longest side to 1024px — plenty for
    // object recognition, keeps the base64 payload small and well under limits.
    const video = videoRef.current
    const canvas = canvasRef.current
    const MAX_DIM = 1024
    const vw = video.videoWidth || 640
    const vh = video.videoHeight || 480
    const scale = Math.min(1, MAX_DIM / Math.max(vw, vh))
    canvas.width = Math.round(vw * scale)
    canvas.height = Math.round(vh * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    // Release stream immediately — image never stored
    releaseStream(streamRef.current)
    streamRef.current = null

    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    // Strip prefix
    const base64 = dataUrl.split(',')[1] ?? ''

    // Guard 4MB limit (~3MB raw in base64)
    if (base64.length > 4 * 1024 * 1024) {
      if (isMountedRef.current) {
        setErrorMsg("This photo is too big! Try getting closer to the object 📸")
        setPhase('error')
      }
      return
    }

    if (!isMountedRef.current) return
    setPhase('loading')
    setResult(null)
    setQuiz(null)
    setQuizAnswered(null)
    setQuizSkipped(false)

    const langs = profile?.preferredLanguages ?? ['en']
    const prompt = buildCameraPrompt(langs, profile?.age ?? 5)

    try {
      const rawText = await geminiClient.analyzeImage(base64, prompt)

      if (!isMountedRef.current) return

      // Safety check on raw response
      const displayText = checkOutput(rawText) ? rawText : ''

      // Try JSON parse
      let parsed: VisionResult | null = null
      if (displayText) {
        try {
          // Strip markdown fences if present
          const cleaned = displayText
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim()
          const obj = JSON.parse(cleaned) as Partial<VisionResult>
          
          // Validate all required fields are present and properly typed
          if (
            typeof obj.objectName === 'string' && obj.objectName.length > 0 &&
            typeof obj.emoji === 'string' && obj.emoji.length > 0 &&
            typeof obj.funFact === 'string' && obj.funFact.length > 0
          ) {
            // Validate translations are all strings
            const translations = obj.translations ?? {}
            const validTranslations = typeof translations === 'object' && translations !== null
              ? Object.fromEntries(
                Object.entries(translations).filter(([_, val]) => typeof val === 'string')
              )
              : {}
            
            parsed = {
              objectName: obj.objectName.slice(0, 100), // Sanitize length
              emoji: obj.emoji.slice(0, 2), // Limit to ~2 emoji chars
              funFact: obj.funFact.slice(0, 500), // Limit length
              translations: validTranslations as Record<string, string>
            }
          }
        } catch (err) {
          // Not valid JSON — fall through to raw display
          console.warn('[Camera] JSON parse failed:', err)
        }
      }

      if (!isMountedRef.current) return

      if (parsed) {
        setResult(parsed)

        // Save to DB (deduplicate by objectName)
        if (profile) {
          try {
            const existing = await db.learnedObjects
              .where('profileId')
              .equals(profile.id)
              .filter(o => o.objectName.toLowerCase() === parsed!.objectName.toLowerCase())
              .first()

            if (existing && existing.id) {
              await safeDbWrite(() =>
                db.learnedObjects.update(existing.id!, {
                  timesRevisited: (existing.timesRevisited ?? 0) + 1
                })
              )
            } else {
              const newObj: LearnedObject = {
                id: crypto.randomUUID(),
                profileId: profile.id,
                objectName: parsed!.objectName,
                emoji: parsed!.emoji,
                translations: JSON.stringify(parsed!.translations ?? {}),
                learnedAt: new Date().toISOString(),
                timesRevisited: 0
              }
              await safeDbWrite(() => db.learnedObjects.add(newObj))
            }
          } catch (dbErr) {
            console.error('[Camera] Failed to save learned object:', dbErr)
          }

          // Bump interest for the object name (don't fail if this errors)
          bumpInterest(profile.id, parsed!.objectName, 2).catch(err => 
            console.error('[Camera] Failed to bump interest:', err)
          )

          // Award XP (don't fail if this errors)
          try {
            const xpResult = await addXP(profile.id, 'photo_taken')
            if (isMountedRef.current) {
              setXpGained(xpResult.gained)
              const leveledUp = xpResult.current.level !== xpResult.previous.level
              setXpLevelUp(
                leveledUp
                  ? `You're now a ${xpResult.current.level}! ${xpResult.current.levelEmoji}`
                  : ''
              )
              setXpVisible(true)
            }
          } catch (xpErr) {
            console.error('[Camera] Failed to award XP:', xpErr)
          }
        }

        // Build quiz
        try {
          const langs = profile?.preferredLanguages ?? ['en']
          if (langs.length === 0) langs.push('en') // Fallback if empty
          const q = buildQuiz(parsed, langs)
          setQuiz(q)
        } catch (quizErr) {
          console.warn('[Camera] Quiz generation failed:', quizErr)
          // Continue without quiz
        }
        setPhase('result')
      } else {
        // Non-JSON fallback: show raw text (truncated)
        const fallbackText = displayText
          ? displayText.slice(0, 300)
          : "Leo couldn't identify that — try again! 🤔"
        setResult({
          objectName: 'Unknown',
          emoji: '🔍',
          funFact: fallbackText,
          translations: {}
        })
        setPhase('result')
      }
    } catch (err) {
      // Log the full error for parents/devs — the UI shows a friendly summary
      console.error('[Camera] analyzeImage failed:', err)
      if (!isMountedRef.current) return
      releaseStream(streamRef.current)
      streamRef.current = null
      // Invalid API key → route to the dedicated key-error screen (Settings link)
      if (err instanceof ApiKeyError) {
        setClientError(err.message)
        setPhase('error')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(`Oops! Leo had trouble: ${msg.slice(0, 240)}`)
      setPhase('error')
    }
  }, [isOnline, geminiClient, clientError, profile])

  // ── Quiz answer ──────────────────────────────────────────────────────────

  const handleAnswer = useCallback(async (idx: number) => {
    if (!quiz || quizAnswered) return
    const isCorrect = idx === quiz.correctIndex

    if (isCorrect) {
      setQuizAnswered('correct')
      if (profile) {
        const xpResult = await addXP(profile.id, 'quiz_correct')
        if (isMountedRef.current) {
          setXpGained(xpResult.gained)
          const leveledUp = xpResult.current.level !== xpResult.previous.level
          setXpLevelUp(
            leveledUp
              ? `You're now a ${xpResult.current.level}! ${xpResult.current.levelEmoji}`
              : ''
          )
          setXpVisible(true)
        }
      }
    } else {
      setQuizAnswered('wrong')
      playOops()
    }
  }, [quiz, quizAnswered, profile])

  // ── Restart camera ────────────────────────────────────────────────────────

  const handleRetake = useCallback(() => {
    setResult(null)
    setQuiz(null)
    setQuizAnswered(null)
    setQuizSkipped(false)
    setErrorMsg('')
    void startCamera()
  }, [startCamera])

  // ── Render ─────────────────────────────────────────────────────────────────

  // Camera turned off by parent
  if (cameraOff) {
    return (
      <SafeArea className="bg-gradient-to-br from-sky-50 to-mint-50">
        <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center">
          <span className="text-8xl">📷</span>
          <div>
            <h2 className="text-2xl font-extrabold text-sky-700">Camera is turned off</h2>
            <p className="mt-2 text-base text-gray-600 font-medium">
              A grown-up can switch it back on in Settings. ⚙️
            </p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-8 py-4 bg-gradient-to-r from-sky-400 to-sky-600 text-white font-extrabold text-lg rounded-3xl shadow-lg active:scale-95"
          >
            ← Back Home
          </button>
        </div>
      </SafeArea>
    )
  }

  // Client error (API key issue)
  if (clientError && phase !== 'loading' && phase !== 'result') {
    return (
      <SafeArea className="bg-gradient-to-br from-sky-50 to-mint-50">
        <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center">
          <span className="text-8xl">🔑</span>
          <p className="text-xl font-extrabold text-sky-700">{clientError}</p>
          <button
            onClick={() => navigate('/settings')}
            className="px-6 py-3 bg-lavender-500 text-white font-extrabold rounded-2xl shadow-lg active:scale-95"
          >
            Go to Settings ⚙️
          </button>
          <button onClick={() => navigate('/')} className="text-lavender-400 font-semibold">
            ← Back Home
          </button>
        </div>
      </SafeArea>
    )
  }

  return (
    <SafeArea className="bg-gradient-to-br from-sky-100 to-mint-100 overflow-hidden">
      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full overflow-y-auto">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-sky-100 flex-shrink-0">
          <button
            onClick={() => {
              releaseStream(streamRef.current)
              streamRef.current = null
              navigate('/')
            }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-sky-100 active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <span className="text-2xl">📷</span>
          <h1 className="font-extrabold text-sky-700 text-lg flex-1">What Is This?</h1>
          {!isOnline && (
            <span className="text-xs font-bold text-orange-500 bg-orange-50 px-2 py-1 rounded-full">
              Offline
            </span>
          )}
        </div>

        {/* ── CONSENT PHASE ──────────────────────────────────────────────── */}
        <AnimatePresence mode="wait">
          {phase === 'consent' && (
            <motion.div
              key="consent"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center py-8"
            >
              <motion.span
                className="text-8xl"
                animate={{ rotate: [-5, 5, -5, 5, 0] }}
                transition={{ duration: 1, repeat: Infinity, repeatDelay: 2 }}
              >
                📷
              </motion.span>
              <div>
                <h2 className="text-2xl font-extrabold text-sky-700 mb-2">
                  Leo wants to see the world!
                </h2>
                <p className="text-base text-sky-600 font-medium">
                  Point your camera at anything — Leo will tell you all about it! 🌍
                </p>
              </div>
              <div className="bg-white rounded-3xl p-4 shadow-sm border border-sky-100 text-sm text-gray-500 font-medium text-left">
                <p className="font-extrabold text-gray-700 mb-1">🔒 Privacy note for parents:</p>
                <p>Photos are analysed instantly by AI and <strong>never saved</strong> to any server or storage. The image is used only to identify the object.</p>
              </div>
              <button
                onClick={handleConsent}
                className="
                  w-full py-4 bg-gradient-to-r from-sky-400 to-mint-500
                  text-white font-extrabold text-xl rounded-3xl shadow-lg
                  active:scale-95 transition-transform
                "
              >
                Let's go! 🚀
              </button>
              <button
                onClick={() => navigate('/')}
                className="text-sky-400 font-semibold"
              >
                Not now
              </button>
            </motion.div>
          )}

          {/* ── CAMERA PHASE ──────────────────────────────────────────────── */}
          {phase === 'camera' && (
            <motion.div
              key="camera"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1 items-center gap-4 py-4 px-4"
            >
              {/* Live video feed */}
              <div className="relative w-full aspect-square max-w-sm rounded-3xl overflow-hidden shadow-2xl bg-black">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                />
                {/* Viewfinder corners */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-4 left-4 w-8 h-8 border-t-4 border-l-4 border-white/70 rounded-tl-xl" />
                  <div className="absolute top-4 right-4 w-8 h-8 border-t-4 border-r-4 border-white/70 rounded-tr-xl" />
                  <div className="absolute bottom-4 left-4 w-8 h-8 border-b-4 border-l-4 border-white/70 rounded-bl-xl" />
                  <div className="absolute bottom-4 right-4 w-8 h-8 border-b-4 border-r-4 border-white/70 rounded-br-xl" />
                </div>
              </div>

              <p className="text-sm text-sky-700 font-bold text-center px-2">
                Point at something interesting and tap the button!
              </p>

              {/* Capture button */}
              <motion.button
                onClick={() => { playTap(); void handleCapture() }}
                whileTap={{ scale: 0.9 }}
                className="
                  w-20 h-20 rounded-full flex-shrink-0
                  bg-gradient-to-br from-coral-400 to-coral-600
                  shadow-xl flex items-center justify-center
                  text-4xl border-4 border-white
                  active:brightness-90
                "
                aria-label="Take photo"
              >
                📷
              </motion.button>
            </motion.div>
          )}

          {/* ── LOADING PHASE ──────────────────────────────────────────────── */}
          {phase === 'loading' && (
            <motion.div
              key="loading"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1 items-center justify-center gap-6 px-6 py-12 text-center"
            >
              <motion.span
                className="text-8xl"
                animate={{ rotate: 360 }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
              >
                🔍
              </motion.span>
              <div>
                <p className="text-2xl font-extrabold text-sky-700">Leo is thinking...</p>
                <p className="text-base text-sky-500 font-medium mt-1">
                  Figuring out what this is! 🧠
                </p>
              </div>
              {/* Animated dots */}
              <div className="flex gap-2">
                {[0, 1, 2].map(i => (
                  <motion.div
                    key={i}
                    className="w-3 h-3 rounded-full bg-sky-400"
                    animate={{ y: [0, -8, 0] }}
                    transition={{ duration: 0.5, delay: i * 0.15, repeat: Infinity }}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {/* ── RESULT PHASE ──────────────────────────────────────────────── */}
          {phase === 'result' && result && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-4 px-4 py-4"
            >
              {/* Result card */}
              <div className="bg-white rounded-3xl p-5 shadow-xl border-2 border-sky-100">
                <div className="flex items-center gap-4 mb-3">
                  <span className="text-6xl leading-none">{result.emoji}</span>
                  <div>
                    <h2 className="text-3xl font-extrabold text-gray-800 capitalize">
                      {result.objectName}
                    </h2>
                    <p className="text-sm text-gray-400 font-medium">Just discovered! 🎉</p>
                  </div>
                </div>

                {/* Fun fact */}
                <div className="bg-leo-50 rounded-2xl px-4 py-3 mb-3">
                  <p className="text-sm font-bold text-leo-700 mb-0.5">Fun Fact!</p>
                  <p className="text-base text-gray-700 font-medium leading-relaxed">
                    {result.funFact}
                  </p>
                </div>

                {/* Translations */}
                {Object.keys(result.translations).filter(l => l !== 'en').length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(result.translations)
                      .filter(([lang]) => lang !== 'en')
                      .map(([lang, val]) => (
                        <span
                          key={lang}
                          className="px-3 py-1.5 bg-lavender-100 text-lavender-700 rounded-full text-sm font-bold"
                        >
                          <span className="opacity-60 text-xs uppercase mr-1">{lang}</span>
                          {val}
                        </span>
                      ))}
                  </div>
                )}
              </div>

              {/* "Teach me more!" button */}
              <button
                onClick={() =>
                  navigate(
                    `/chat?q=${encodeURIComponent(`Tell me more about ${result.objectName}`)}`
                  )
                }
                className="
                  w-full py-4 bg-gradient-to-r from-lavender-500 to-lavender-700
                  text-white font-extrabold text-lg rounded-3xl shadow-lg
                  active:scale-95 transition-transform
                "
              >
                Teach me more! 🦁
              </button>

              {/* ── QUIZ SECTION ──────────────────────────────────────────── */}
              {quiz && !quizSkipped && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="bg-white rounded-3xl p-5 shadow-md border-2 border-mint-100"
                >
                  <p className="text-xs font-extrabold text-mint-600 uppercase tracking-wider mb-2">
                    Mini Quiz 🧩
                  </p>
                  <p className="text-base font-extrabold text-gray-800 mb-4 leading-snug">
                    {quiz.text}
                  </p>

                  <div className="flex flex-col gap-2 mb-3">
                    {quiz.options.map((opt, idx) => {
                      let btnClass =
                        'w-full py-3 px-4 rounded-2xl font-extrabold text-lg border-2 transition-all active:scale-95 '
                      if (quizAnswered === 'correct' && idx === quiz.correctIndex) {
                        btnClass += 'bg-mint-400 border-mint-500 text-white'
                      } else if (quizAnswered === 'wrong' && idx === quiz.correctIndex) {
                        btnClass += 'bg-mint-300 border-mint-400 text-white'
                      } else if (quizAnswered) {
                        btnClass += 'bg-gray-100 border-gray-200 text-gray-400'
                      } else {
                        btnClass += 'bg-lavender-50 border-lavender-200 text-lavender-700 hover:bg-lavender-100'
                      }

                      return (
                        <button
                          key={idx}
                          onClick={() => void handleAnswer(idx)}
                          disabled={quizAnswered !== null}
                          className={btnClass}
                        >
                          {opt}
                        </button>
                      )
                    })}
                  </div>

                  {/* Feedback */}
                  <AnimatePresence>
                    {quizAnswered === 'correct' && (
                      <motion.p
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center text-mint-700 font-extrabold text-lg"
                      >
                        Amazing! You got it! 🎉
                      </motion.p>
                    )}
                    {quizAnswered === 'wrong' && (
                      <motion.p
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center text-coral-600 font-extrabold text-base"
                      >
                        Oops! The answer was {quiz.options[quiz.correctIndex]}! Try the next one! 💪
                      </motion.p>
                    )}
                  </AnimatePresence>

                  {!quizAnswered && (
                    <button
                      onClick={() => setQuizSkipped(true)}
                      className="w-full py-2 text-sm text-gray-400 font-semibold"
                    >
                      Skip Quiz
                    </button>
                  )}
                </motion.div>
              )}

              {/* "Take Another Photo" button — show after quiz answered/skipped */}
              {(quizAnswered || quizSkipped) && (
                <motion.button
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={handleRetake}
                  className="
                    w-full py-4 bg-gradient-to-r from-sky-400 to-mint-500
                    text-white font-extrabold text-lg rounded-3xl shadow-lg
                    active:scale-95 transition-transform
                  "
                >
                  Take Another Photo 📷
                </motion.button>
              )}

              {/* Show retake even before quiz if quiz section is not present */}
              {!quiz && (
                <button
                  onClick={handleRetake}
                  className="
                    w-full py-4 bg-gradient-to-r from-sky-400 to-mint-500
                    text-white font-extrabold text-lg rounded-3xl shadow-lg
                    active:scale-95 transition-transform
                  "
                >
                  Take Another Photo 📷
                </button>
              )}
            </motion.div>
          )}

          {/* ── ERROR PHASE ──────────────────────────────────────────────── */}
          {phase === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center py-12"
            >
              <span className="text-8xl">😅</span>
              <div>
                <h2 className="text-2xl font-extrabold text-coral-600 mb-2">Oops!</h2>
                <p className="text-base text-gray-600 font-medium leading-relaxed">{errorMsg}</p>
              </div>
              <button
                onClick={handleRetake}
                className="
                  px-8 py-4 bg-gradient-to-r from-sky-400 to-sky-600
                  text-white font-extrabold text-lg rounded-3xl shadow-lg
                  active:scale-95
                "
              >
                Try Again 📷
              </button>
              <button onClick={() => navigate('/')} className="text-sky-400 font-semibold">
                ← Back Home
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* XP Celebration overlay */}
      <XPCelebration
        visible={xpVisible}
        gained={xpGained}
        levelUpLabel={xpLevelUp}
        onDismiss={() => setXpVisible(false)}
      />
    </SafeArea>
  )
}
