import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { db } from '../db/index'
import type { LearnedObject } from '../db/index'
import { useAppStore } from '../store/app'
import { decryptApiKey } from '../lib/crypto'
import { createGeminiClient, type GeminiClient } from '../lib/gemini'
import { speak, stopSpeaking } from '../lib/voice'
import { bumpInterest } from '../lib/memory'
import { addXP } from '../lib/xp'
import { buildTranslationPrompt } from '../prompts/index'
import { checkInput, checkOutput, SAFE_DEFLECTION } from '../lib/safety'
import { useSpeech } from '../hooks/useSpeech'
import { LeoMascot } from '../components/LeoMascot'
import { VoiceButton } from '../components/VoiceButton'
import { XPCelebration } from '../components/XPCelebration'
import { SafeArea } from '../components/SafeArea'

// ─── Language display names ───────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  kn: 'Kannada',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu'
}

// ─── Raw Gemini translation response ─────────────────────────────────────────

interface RawTranslation {
  word?: string
  translation?: string
  pronunciation?: string
  exampleSentence?: string
}

// ─── Translation result type ──────────────────────────────────────────────────

interface TranslationResult {
  word: string
  translation: string
  pronunciation: string
  exampleSentence: string
  language: string
}

// ─── Translation request parser ───────────────────────────────────────────────

interface ParsedRequest {
  word: string
  language: string
}

const LANG_ALIASES: Record<string, string> = {
  kannada: 'kn',
  hindi: 'hi',
  tamil: 'ta',
  telugu: 'te',
  english: 'en',
  kn: 'kn',
  hi: 'hi',
  ta: 'ta',
  te: 'te',
  en: 'en'
}

function parseTranslationRequest(
  transcript: string,
  fallbackLang: string
): ParsedRequest {
  const lower = transcript.toLowerCase().trim()

  // Pattern: "what is X in Y" / "how do you say X in Y" / "say X in Y" / "X in Y"
  const patterns = [
    /(?:what is|how do you say|say|translate)\s+(.+?)\s+in\s+(\w+)/i,
    /(.+?)\s+in\s+(\w+)$/i
  ]

  for (const pattern of patterns) {
    const match = lower.match(pattern)
    if (match) {
      const word = match[1].trim()
      const langRaw = match[2].trim().toLowerCase()
      const lang = LANG_ALIASES[langRaw] ?? fallbackLang
      if (word.length > 0) return { word, language: lang }
    }
  }

  // No pattern matched — treat the whole transcript as the word to translate
  return { word: lower.replace(/[^a-z\s]/g, '').trim() || transcript.trim(), language: fallbackLang }
}

// ─── Word card component ──────────────────────────────────────────────────────

interface WordCardProps {
  item: LearnedObject
  primaryLang: string
  onSpeak: (text: string, lang: string) => void
}

function WordCard({ item, primaryLang, onSpeak }: WordCardProps) {
  let translations: Record<string, string> = {}
  try {
    translations = JSON.parse(item.translations) as Record<string, string>
  } catch {
    translations = {}
  }

  const translationEntries = Object.entries(translations).filter(
    ([lang]) => lang !== 'en'
  )
  if (translationEntries.length === 0) return null

  const firstEntry = translationEntries[0]

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.95 }}
      onClick={() => {
        const tval = translations[primaryLang] ?? translations['en'] ?? item.objectName
        void onSpeak(tval, primaryLang)
      }}
      className="
        flex flex-col items-center gap-1
        bg-white rounded-2xl p-3 shadow-sm
        border border-lavender-100
        active:shadow-md transition-shadow
        min-h-[80px]
      "
    >
      <span className="text-3xl leading-none">{item.emoji}</span>
      <p className="text-xs font-extrabold text-gray-700 text-center leading-tight">
        {item.objectName}
      </p>
      <span
        className="
          text-xs font-bold px-2 py-0.5 rounded-full
          bg-lavender-100 text-lavender-700 truncate max-w-full
        "
      >
        {firstEntry[1]}
      </span>
    </motion.button>
  )
}

// ─── Translation response card ────────────────────────────────────────────────

interface TranslationCardProps {
  result: TranslationResult
  onSpeak: (text: string, lang: string) => void
}

function TranslationCard({ result, onSpeak }: TranslationCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="
        bg-white rounded-3xl p-5 shadow-lg
        border-2 border-lavender-200
        mx-2
      "
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-400 uppercase tracking-wide">
            {LANG_NAMES[result.language] ?? result.language}
          </p>
          <p className="text-3xl font-extrabold text-lavender-700 mt-1 leading-tight">
            {result.translation}
          </p>
          {result.pronunciation && (
            <p className="text-sm text-gray-500 font-medium mt-1 italic">
              /{result.pronunciation}/
            </p>
          )}
        </div>
        <button
          onClick={() => onSpeak(result.translation, result.language)}
          className="
            w-12 h-12 flex items-center justify-center flex-shrink-0
            bg-lavender-100 rounded-full text-2xl
            active:scale-90 transition-transform
          "
          aria-label="Speak translation"
        >
          🔊
        </button>
      </div>

      {result.exampleSentence && (
        <div className="mt-3 pt-3 border-t border-lavender-100">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
            Example
          </p>
          <p className="text-sm text-gray-600 font-medium leading-relaxed">
            {result.exampleSentence}
          </p>
        </div>
      )}
    </motion.div>
  )
}

// ─── WordExplorerScreen ───────────────────────────────────────────────────────

export function WordExplorerScreen() {
  const navigate = useNavigate()
  const { profile, googleSub, isOnline } = useAppStore()

  const primaryLang = profile?.preferredLanguages[0] ?? 'en'
  const secondaryLang = profile?.preferredLanguages[1] ?? 'en'
  const targetLang = secondaryLang !== 'en' ? secondaryLang : (primaryLang !== 'en' ? primaryLang : 'hi')

  const [geminiClient, setGeminiClient] = useState<GeminiClient | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [leoMood, setLeoMood] = useState<'happy' | 'thinking' | 'excited' | 'sleeping'>('happy')
  const [translationResult, setTranslationResult] = useState<TranslationResult | null>(null)
  const [responseText, setResponseText] = useState('')
  const [learnedWords, setLearnedWords] = useState<LearnedObject[]>([])
  const [apiError, setApiError] = useState(false)

  // XP celebration state
  const [xpVisible, setXpVisible] = useState(false)
  const [xpGained, setXpGained] = useState(0)
  const [xpLevelUp, setXpLevelUp] = useState('')

  const isMountedRef = useRef(true)

  const { transcript, isListening, startListening, stopListening, error: speechError, isSupported } = useSpeech(primaryLang)

  // ── isMounted guard ────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      stopSpeaking()
    }
  }, [])

  // ── Load Gemini client ─────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function init() {
      if (!profile || !googleSub) return
      try {
        const settings = await db.appSettings.get('main')
        if (!settings?.apiKeyEncrypted) {
          if (!cancelled) setApiError(true)
          return
        }
        const apiKey = await decryptApiKey(settings.apiKeyEncrypted, googleSub)
        if (cancelled) return
        setGeminiClient(createGeminiClient(apiKey, {
          chatModel: settings.chatModel,
          visionModel: settings.visionModel
        }))
      } catch {
        if (!cancelled) setApiError(true)
      }
    }

    void init()
    return () => { cancelled = true }
  }, [profile, googleSub])

  // ── Load learned words ─────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function loadWords() {
      if (!profile) return
      try {
        const all = await db.learnedObjects
          .where('profileId')
          .equals(profile.id)
          .toArray()

        // Filter to those that have non-English translations
        const withTranslations = all.filter(obj => {
          try {
            const t = JSON.parse(obj.translations) as Record<string, string>
            return Object.keys(t).some(k => k !== 'en')
          } catch {
            return false
          }
        })

        const sorted = withTranslations
          .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
          .slice(0, 20)

        if (!cancelled) setLearnedWords(sorted)
      } catch (err) {
        console.error('[WordExplorer] load words failed:', err)
      }
    }

    void loadWords()
    return () => { cancelled = true }
  }, [profile])

  // ── TTS helper ─────────────────────────────────────────────────────────────

  const speakText = useCallback((text: string, lang: string) => {
    setIsSpeaking(true)
    speak(text, lang)
      .then(() => { if (isMountedRef.current) setIsSpeaking(false) })
      .catch(() => { if (isMountedRef.current) setIsSpeaking(false) })
  }, [])

  // ── Handle transcript ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!transcript || isListening) return
    void handleTranscriptRef.current?.(transcript)
  }, [transcript, isListening])

  const handleTranscriptRef = useRef<(text: string) => Promise<void> | void>()

  const handleTranscript = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return

    // Safety check
    if (!checkInput(text)) {
      speakText(SAFE_DEFLECTION, primaryLang)
      setResponseText(SAFE_DEFLECTION)
      return
    }

    const { word, language } = parseTranslationRequest(text, targetLang)

    if (!isOnline || !geminiClient) {
      // Offline fallback: look in cache
      const cached = learnedWords.find(
        w => w.objectName.toLowerCase() === word.toLowerCase()
      )
      if (cached) {
        let t: Record<string, string> = {}
        try { t = JSON.parse(cached.translations) as Record<string, string> } catch { t = {} }
        const val = t[language] ?? t['en'] ?? cached.objectName
        const msg = `In ${LANG_NAMES[language] ?? language}, ${word} is "${val}"! 🌍`
        setResponseText(msg)
        speakText(msg, primaryLang)
      } else {
        const msg = "I need internet to translate! Let's try when we're connected! 🌐"
        setResponseText(msg)
        speakText(msg, primaryLang)
      }
      return
    }

    if (!isMountedRef.current) return
    setIsLoading(true)
    setLeoMood('thinking')
    setTranslationResult(null)
    setResponseText('')

    try {
      const prompt = buildTranslationPrompt(word, language)
      const response = await geminiClient.streamChat(
        'You are a helpful language teacher for children. Always respond with valid JSON only.',
        prompt,
        () => { /* no streaming display for translations */ }
      )

      if (!isMountedRef.current) return

      // Safety check output
      if (!checkOutput(response)) {
        const msg = "Oops, let me think of something better! 🦁"
        setResponseText(msg)
        speakText(msg, primaryLang)
        return
      }

      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as RawTranslation
        const result: TranslationResult = {
          word: typeof parsed.word === 'string' ? parsed.word : word,
          translation: typeof parsed.translation === 'string' ? parsed.translation : '',
          pronunciation: typeof parsed.pronunciation === 'string' ? parsed.pronunciation : '',
          exampleSentence: typeof parsed.exampleSentence === 'string' ? parsed.exampleSentence : '',
          language
        }

        if (!isMountedRef.current) return
        setTranslationResult(result)
        setLeoMood('excited')

        const announcement = `In ${LANG_NAMES[language] ?? language}, ${result.word} is "${result.translation}"! ${result.pronunciation ? `You say it like: ${result.pronunciation}` : ''}`
        speakText(announcement, primaryLang)

        // Bump interest for the word
        if (profile) {
          await bumpInterest(profile.id, result.word, 1)
        }

        // Save to learned objects if it's a new word
        if (profile) {
          const existing = await db.learnedObjects
            .where('profileId').equals(profile.id)
            .filter(o => o.objectName.toLowerCase() === result.word.toLowerCase())
            .first()

          if (existing) {
            const currentTranslations = JSON.parse(existing.translations) as Record<string, string>
            currentTranslations[language] = result.translation
            await db.learnedObjects.update(existing.id, {
              translations: JSON.stringify(currentTranslations),
              timesRevisited: existing.timesRevisited + 1
            })
          } else {
            await db.learnedObjects.add({
              id: crypto.randomUUID(),
              profileId: profile.id,
              objectName: result.word,
              emoji: '🌍',
              translations: JSON.stringify({ en: result.word, [language]: result.translation }),
              learnedAt: new Date().toISOString(),
              timesRevisited: 0
            })

            // Award XP for learning a brand-new word
            try {
              const xpResult = await addXP(profile.id, 'word_learned')
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
              console.error('[WordExplorer] Failed to award XP:', xpErr)
            }
          }

          // Refresh word list
          const all = await db.learnedObjects
            .where('profileId').equals(profile.id)
            .toArray()
          const withT = all.filter(obj => {
            try {
              const t = JSON.parse(obj.translations) as Record<string, string>
              return Object.keys(t).some(k => k !== 'en')
            } catch { return false }
          })
          if (isMountedRef.current) {
            setLearnedWords(
              withT
                .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
                .slice(0, 20)
            )
          }
        }
      } else {
        // Couldn't parse JSON — show raw response
        const msg = response.slice(0, 150)
        setResponseText(msg)
        speakText(msg, primaryLang)
      }
    } catch (err) {
      if (!isMountedRef.current) return
      const msg = "Oops! Leo couldn't find that word. Let's try again! 🦁"
      setResponseText(msg)
      speakText(msg, primaryLang)
      console.error('[WordExplorer] translation error:', err)
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
        setLeoMood('happy')
      }
    }
  }, [isLoading, isOnline, geminiClient, primaryLang, targetLang, learnedWords, profile, speakText])

  // Update ref whenever handleTranscript changes
  useEffect(() => {
    handleTranscriptRef.current = handleTranscript
  }, [handleTranscript])

  // ── Language chips in Leo's speech bubble ─────────────────────────────────

  const langList = (profile?.preferredLanguages ?? ['en'])
    .map(l => LANG_NAMES[l] ?? l)
    .join(', ')

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeArea className="bg-gradient-to-br from-violet-100 via-lavender-50 to-mint-100 overflow-hidden">
      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-lavender-100">
          <button
            onClick={() => { stopSpeaking(); navigate('/') }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90 flex-shrink-0"
            aria-label="Go back"
          >
            ←
          </button>
          <div className="flex-1">
            <p className="font-extrabold text-lavender-700 text-lg">🌍 Word Explorer</p>
            <p className="text-xs text-lavender-400 font-medium">
              {isLoading ? 'Translating...' : isSpeaking ? 'Speaking...' : isListening ? 'Listening...' : 'Ask me to translate!'}
            </p>
          </div>
          {!isOnline && (
            <span className="text-xs font-bold text-orange-500 bg-orange-50 px-2 py-1 rounded-full flex-shrink-0">
              Offline
            </span>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">

          {/* Leo + speech bubble */}
          <div className="flex flex-col items-center pt-5 pb-4 px-4">
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.2 }}
              className="
                relative bg-white rounded-3xl px-5 py-3 shadow-md
                mb-4 max-w-[280px] text-center
                before:content-[''] before:absolute before:bottom-[-10px] before:left-1/2
                before:-translate-x-1/2 before:border-[10px] before:border-transparent
                before:border-t-white
              "
            >
              <p className="text-sm font-bold text-lavender-700 leading-relaxed">
                {isLoading
                  ? 'Let me look that up... 🔍'
                  : `Say a word and I'll tell you how to say it in ${langList}!`}
              </p>
            </motion.div>

            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
            >
              <LeoMascot size="md" mood={leoMood} speaking={isSpeaking} />
            </motion.div>
          </div>

          {/* Voice button */}
          <div className="flex justify-center py-4">
            {apiError ? (
              <div className="text-center px-6">
                <p className="text-sm text-orange-600 font-semibold">
                  Magic key not set up yet! Ask a parent to check Settings. ⚙️
                </p>
                <button
                  onClick={() => navigate('/settings')}
                  className="mt-3 px-5 py-2 bg-lavender-500 text-white font-bold rounded-2xl text-sm active:scale-95"
                >
                  Go to Settings
                </button>
              </div>
            ) : !isSupported ? (
              <p className="text-sm text-gray-500 font-medium text-center px-6">
                Voice not supported in this browser. Try Chrome on Android or Safari on iOS.
              </p>
            ) : (
              <VoiceButton
                isListening={isListening}
                onStart={startListening}
                onStop={stopListening}
                disabled={isLoading || isSpeaking}
              />
            )}
          </div>

          {/* Speech error */}
          {speechError && (
            <p className="text-xs text-red-400 font-medium text-center px-4 pb-2">
              {speechError}
            </p>
          )}

          {/* Translation result */}
          <AnimatePresence mode="wait">
            {translationResult && (
              <div className="px-2 pb-4">
                <TranslationCard
                  result={translationResult}
                  onSpeak={speakText}
                />
              </div>
            )}
            {!translationResult && responseText && (
              <motion.div
                key="response-text"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mx-4 mb-4 bg-white rounded-2xl px-4 py-3 shadow-sm border border-lavender-100"
              >
                <p className="text-sm font-semibold text-gray-700 text-center">{responseText}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex justify-center pb-4">
              <div className="flex gap-2 items-center bg-white px-4 py-2 rounded-full shadow-sm">
                {[0, 1, 2].map(i => (
                  <motion.div
                    key={i}
                    className="w-2 h-2 bg-lavender-400 rounded-full"
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 0.5, delay: i * 0.15, repeat: Infinity }}
                  />
                ))}
                <span className="text-xs text-lavender-500 font-semibold ml-1">
                  Translating...
                </span>
              </div>
            </div>
          )}

          {/* Recently learned words grid */}
          <div className="px-4 pb-6">
            <p className="text-sm font-extrabold text-lavender-600 mb-3">
              My Word Collection
            </p>

            {learnedWords.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-8"
              >
                <span className="text-5xl block mb-3">🌍</span>
                <p className="text-sm font-bold text-lavender-500">
                  No words yet! Ask me to translate something! 🌟
                </p>
              </motion.div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {learnedWords.map(item => (
                  <WordCard
                    key={item.id}
                    item={item}
                    primaryLang={primaryLang}
                    onSpeak={speakText}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
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
