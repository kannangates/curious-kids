import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { db, getRecentSummaries } from '../db/index'
import { useAppStore } from '../store/app'
import { decryptApiKey } from '../lib/crypto'
import { createGeminiClient, SafetyError, NetworkError, ApiKeyError, ModelDeprecatedError, type GeminiClient } from '../lib/gemini'
import { speak, stopSpeaking } from '../lib/voice'
import { checkInput, checkOutput, SAFE_DEFLECTION } from '../lib/safety'
import { createIdleTimer, generateSessionSummary, initSessionTriggers, type IdleTimer } from '../lib/session'
import { extractTopics, bumpInterest, getTopInterests } from '../lib/memory'
import { getLocalAnswer } from '../lib/localAnswers'
import { detectIntent, type Intent } from '../lib/intents'
import { detectLanguageOr } from '../lib/languageDetect'
import { LANG_NAME, isAppLang, type AppLang } from '../lib/langs'
import { startRecording, blobToBase64, type RecorderHandle } from '../lib/audioRecorder'
import { logEvent } from '../lib/debugLog'
import { addXP } from '../lib/xp'
import { buildSystemPrompt, FALLBACK_OFFLINE_RESPONSES } from '../prompts/index'
import { useSpeech } from '../hooks/useSpeech'
import { LeoMascot } from '../components/LeoMascot'
import { VoiceButton } from '../components/VoiceButton'
import { SafeArea } from '../components/SafeArea'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

// ─── ChatScreen ───────────────────────────────────────────────────────────────

export function ChatScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { profile, googleSub, isOnline, sessionTopics, addSessionTopic, startSession, endSession, sessionStart } = useAppStore()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [apiKeyError, setApiKeyError] = useState<boolean | string>(false)
  const [geminiClient, setGeminiClient] = useState<GeminiClient | null>(null)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [leoMood, setLeoMood] = useState<'happy' | 'thinking' | 'excited' | 'sleeping'>('happy')
  // Pending intent suggestion — when the kid says "play a game" / "tell me a
  // story" etc., Leo offers to navigate via a confirm chip (tap-only, never
  // automatic) so accidental keyword matches don't yank the kid out of chat.
  const [pendingIntent, setPendingIntent] = useState<Intent | null>(null)
  // Audio capture mode — used when the active language is non-English so we
  // skip the browser's unreliable Indian-language STT and send the audio to
  // Gemini directly. English keeps the Web Speech path.
  const [isRecording, setIsRecording] = useState(false)
  const recorderRef = useRef<RecorderHandle | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const idleTimerRef = useRef<IdleTimer | null>(null)
  const isMountedRef = useRef(true)
  const hasEndedRef = useRef(false)
  const pendingSpeakRef = useRef<Promise<void> | null>(null)
  const qParamHandledRef = useRef(false)
  const handleUserMessageRef = useRef<(text: string) => Promise<void> | void>()
  // Profile's "home" language — used as the default and as a fallback when
  // the child writes pure punctuation / single letters.
  const homeLangRaw = profile?.preferredLanguages[0] ?? 'en'
  const homeLang: AppLang = isAppLang(homeLangRaw) ? homeLangRaw : 'en'
  // Active spoken/heard language — updates per utterance via detectLanguage.
  // Drives TTS, STT, and the runtime hint to Gemini, so a kid switching to
  // Kannada or Hindi mid-conversation gets Leo back in that language.
  const [activeLang, setActiveLang] = useState<AppLang>(homeLang)
  // Memoised "lang" name — keeps useEffect deps stable for downstream consumers.
  const lang = activeLang  // kept as a local alias so existing call sites need no rename

  const { transcript, interimTranscript, isListening, startListening, stopListening, error: speechError, isSupported } = useSpeech(activeLang)

  // ── Scroll to bottom ────────────────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // ── isMounted guard ────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // Make sure any active audio recording is torn down on unmount so the
      // mic indicator doesn't keep showing after the kid leaves the screen.
      if (recorderRef.current) {
        try { void recorderRef.current.stop() } catch { /* ignore */ }
        recorderRef.current = null
      }
    }
  }, [])

  // ── Session end handler ────────────────────────────────────────────────────

  const handleSessionEnd = useCallback(async () => {
    if (hasEndedRef.current) return
    hasEndedRef.current = true

    stopSpeaking()
    idleTimerRef.current?.clear()

    if (geminiClient && sessionStart) {
      const duration = Date.now() - sessionStart
      await generateSessionSummary(
        profile!.id,
        sessionTopics,
        duration,
        geminiClient
      )
      // Award XP for completing a chat session that actually explored topics.
      // Silent (no celebration) since the session is ending / page is closing.
      if (profile && sessionTopics.length > 0) {
        await addXP(profile.id, 'chat_session').catch(() => { /* non-fatal */ })
      }
    }
    if (isMountedRef.current) endSession()
  }, [geminiClient, sessionStart, profile, sessionTopics, endSession])

  // ── Initialize: load API key, build prompt ─────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function init() {
      if (!profile || !googleSub) return

      try {
        const settings = await db.appSettings.get('main')
        if (!settings?.apiKeyEncrypted) {
          if (!cancelled) setApiKeyError(true)
          return
        }

        let apiKey: string
        try {
          apiKey = await decryptApiKey(settings.apiKeyEncrypted, googleSub)
        } catch (err) {
          if (!cancelled) {
            if (err instanceof DOMException || (err instanceof Error && err.message?.includes('decrypt'))) {
              setApiKeyError('Signed in with a different Google account. Please sign out and sign in with the same account used during setup.')
            } else {
              setApiKeyError('Could not load the magic key. Please check settings.')
            }
          }
          return
        }
        if (cancelled) return

        const client = createGeminiClient(apiKey, {
          chatModel: settings.chatModel,
          visionModel: settings.visionModel
        })
        setGeminiClient(client)

        // Build system prompt using top interests from memory module +
        // recent discoveries so chat feels like a continuation, not cold.
        const topInterests = await getTopInterests(profile.id, 3)
        const recentSummaries = await getRecentSummaries(profile.id, 2)
        const recentLearned = await db.learnedObjects
          .where('profileId').equals(profile.id)
          .toArray()
        const recentDiscoveries = recentLearned
          .sort((a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime())
          .slice(0, 5)
          .map(o => o.objectName)
        const prompt = buildSystemPrompt(
          profile,
          topInterests.map(t => t.tag),
          recentSummaries.map(s => s.summary),
          { recentDiscoveries, recentSummaries: recentSummaries.map(s => s.summary) }
        )
        if (cancelled) return
        setSystemPrompt(prompt)
      } catch (err) {
        console.error('Chat init failed:', err)
        if (!cancelled) setApiKeyError(true)
      }
    }

    void init()
    startSession()

    return () => { cancelled = true }
  }, [profile, googleSub, startSession])

  // ── Pre-fill from ?q= query param (e.g. from Discoveries "Ask Leo more") ───
  // Wait until geminiClient is ready before firing — PBKDF2 derivation can take
  // 300-800ms on mobile, so a fixed timeout risks sending before client exists.
  // Use ref pattern to avoid forward reference issue

  useEffect(() => {
    const q = searchParams.get('q')
    if (!q || !geminiClient || qParamHandledRef.current) return
    qParamHandledRef.current = true
    void handleUserMessageRef.current?.(q)
  }, [geminiClient, searchParams])

  // ── Idle timer ────────────────────────────────────────────────────────────

  useEffect(() => {
    idleTimerRef.current = createIdleTimer(() => {
      void handleSessionEnd()
    }, 90_000)

    return () => {
      idleTimerRef.current?.clear()
    }
  }, [handleSessionEnd])

  // ── Cleanup on unmount (session end) ──────────────────────────────────────

  useEffect(() => {
    return () => {
      stopSpeaking()
      void handleSessionEnd()
    }
  }, [handleSessionEnd])

  // ── Wire up page-hide / beforeunload session triggers ─────────────────────

  useEffect(() => {
    const cleanup = initSessionTriggers(() => {
      if (!hasEndedRef.current) void handleSessionEnd()
    })
    return cleanup
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handle transcript when speech ends ────────────────────────────────────

  useEffect(() => {
    if (transcript && !isListening) {
      void handleUserMessage(transcript)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript, isListening])

  // ── speakAndTrack helper ───────────────────────────────────────────────────

  const speakAndTrack = useCallback((text: string, language: string): Promise<void> => {
    setIsSpeaking(true)
    // Defense in depth: even with voice.ts's watchdog, guarantee isSpeaking
    // clears within 60s so a stalled TTS engine can NEVER permanently disable
    // the mic button.
    const safetyTimeout = window.setTimeout(() => {
      if (isMountedRef.current) setIsSpeaking(false)
    }, 60_000)
    const clear = () => {
      window.clearTimeout(safetyTimeout)
      if (isMountedRef.current) setIsSpeaking(false)
    }
    const p = speak(text, language).then(clear).catch(clear)
    pendingSpeakRef.current = p
    return p
  }, [])

  // ── Send message to Gemini ─────────────────────────────────────────────────

  const handleUserMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return

    // Fix 26: stop any ongoing speech and reset before processing new message
    stopSpeaking()

    idleTimerRef.current?.reset()

    // Detect the kid's spoken/written language for THIS message FIRST so
    // every branch below (safety deflect, intent, local answer, Gemini)
    // speaks back in the matching language. Falls back to the previous
    // active language for pure punctuation. Drives the voice picked by
    // selectVoice, the next STT pass, and the hint we attach to Gemini.
    const detected = detectLanguageOr(text, activeLang)
    if (detected !== activeLang) {
      setActiveLang(detected)
      logEvent('info', `[Chat] language switched → ${detected}`)
    }
    const replyLang: AppLang = detected

    // Safety check on input
    if (!checkInput(text)) {
      const deflectMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: SAFE_DEFLECTION,
        timestamp: Date.now()
      }
      if (!isMountedRef.current) return
      setMessages(prev => [...prev.slice(-9), deflectMsg])
      setLeoMood('happy')
      await speakAndTrack(SAFE_DEFLECTION, replyLang)
      return
    }

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      timestamp: Date.now()
    }
    if (!isMountedRef.current) return
    setMessages(prev => [...prev.slice(-9), userMsg])

    // Extract topics for session tracking and interest bump
    const keywords = extractTopics(text)
    keywords.forEach(k => addSessionTopic(k))

    // Voice intent detection — kid says "play a game" / "tell me a story"
    // → Leo offers to open the right mode. Confirm chip; never auto-navs.
    const intent = detectIntent(text)
    if (intent) {
      const intentMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: intent.prompt,
        timestamp: Date.now()
      }
      if (!isMountedRef.current) return
      setMessages(prev => [...prev.slice(-9), intentMsg])
      setPendingIntent(intent)
      setLeoMood('excited')
      await speakAndTrack(intent.prompt, replyLang)
      return
    }

    // Answer time/date questions locally — the AI has no clock, and these
    // should be instant + correct (works offline too).
    const local = getLocalAnswer(text)
    if (local) {
      const localMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: local,
        timestamp: Date.now()
      }
      if (!isMountedRef.current) return
      setMessages(prev => [...prev.slice(-9), localMsg])
      setLeoMood('happy')
      await speakAndTrack(local, replyLang)
      return
    }

    // Handle offline
    if (!isOnline || !geminiClient) {
      const idx = Math.floor(Math.random() * FALLBACK_OFFLINE_RESPONSES.length)
      const fallback = FALLBACK_OFFLINE_RESPONSES[idx]
      const fallbackMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: fallback,
        timestamp: Date.now()
      }
      if (!isMountedRef.current) return
      setMessages(prev => [...prev.slice(-9), fallbackMsg])
      await speakAndTrack(fallback, replyLang)
      return
    }

    // Call Gemini
    if (!isMountedRef.current) return
    setIsLoading(true)
    setLeoMood('thinking')

    let fullResponse = ''
    let sentenceBuffer = ''
    const assistantMsgId = crypto.randomUUID()

    // Add empty assistant message to fill in
    setMessages(prev => [
      ...prev.slice(-9),
      { id: assistantMsgId, role: 'assistant', text: '', timestamp: Date.now() }
    ])

    // Tell Gemini which language to reply in. We attach it as a short
    // [hint] line on the USER message rather than mutating the system
    // prompt — keeps the system prompt cacheable and lets the language
    // change message-to-message.
    const langHint = replyLang === 'en'
      ? ''  // English is the default; no hint needed (saves a few tokens)
      : `[Reply in ${LANG_NAME[replyLang]} — the child wrote in ${LANG_NAME[replyLang]} script. Keep words simple and natural for a ${profile?.age ?? 5}-year-old.]\n`
    const userMessageWithHint = langHint + text

    try {
      await geminiClient.streamChat(
        systemPrompt,
        userMessageWithHint,
        (chunk) => {
          if (!isMountedRef.current) return
          fullResponse += chunk
          sentenceBuffer += chunk

          // Update message in real-time
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, text: fullResponse } : m
            )
          )

          // Speak complete sentences as they arrive — use replyLang (the
          // detected language for THIS turn). The activeLang state setter
          // is async, so reading `lang` here would speak the *previous*
          // language for the first message after a switch.
          const sentenceMatch = sentenceBuffer.match(/^(.+?[.!?])\s*/)
          if (sentenceMatch) {
            const sentence = sentenceMatch[1]
            sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length)
            setLeoMood('excited')
            void speakAndTrack(sentence, replyLang).then(() => {
              if (isMountedRef.current) setLeoMood('happy')
            })
          } else if (sentenceBuffer.length > 200) {
            // Fix 7: fallback for long buffers with no punctuation
            void speakAndTrack(sentenceBuffer.trim(), replyLang)
            sentenceBuffer = ''
          }
        }
      )

      // Speak any remaining buffer
      if (sentenceBuffer.trim()) {
        if (isMountedRef.current) {
          await speakAndTrack(sentenceBuffer.trim(), replyLang)
        }
      }

      if (!isMountedRef.current) return

      // Empty response (e.g. model returned no usable text) — don't leave the
      // bubble stuck on loading dots; give a friendly nudge.
      if (!fullResponse.trim()) {
        const emptyMsg = "Hmm, I didn't quite catch that! Can you ask me again? 🦁"
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: emptyMsg } : m))
        await speakAndTrack(emptyMsg, replyLang)
        return
      }

      // Safety check output — discard and replace with safe message
      if (!checkOutput(fullResponse)) {
        const safeMsg = "Oops, let me think of something better! 🦁"
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMsgId ? { ...m, text: safeMsg } : m
          )
        )
        stopSpeaking()
        await speakAndTrack(safeMsg, replyLang)
        if (!isMountedRef.current) return
        return // Don't bump interests for unsafe responses
      }

      // Extract topics from response and bump interests
      const responseKeywords = extractTopics(fullResponse)
      responseKeywords.forEach(k => addSessionTopic(k))
      if (profile) {
        for (const keyword of responseKeywords) {
          void bumpInterest(profile.id, keyword, 1)
        }
      }

    } catch (err) {
      // Surface the real error for diagnostics (UI stays kid-friendly).
      // Log message + name explicitly — Safari's err.stack drops the message
      // header, so relying on console.error alone hides the actual reason.
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      logEvent('error', `[Chat] message failed: ${errMsg}`, err)
      console.error('[Chat] message failed:', err)

      // Invalid API key → show the dedicated key-setup screen (has Settings link)
      if (err instanceof ApiKeyError) {
        if (isMountedRef.current) setApiKeyError(err.message)
        return
      }

      // Google retired the model → route to a Settings link (the App-mount
      // migration also flips the persisted model, so this should only fire
      // for someone who pinned a now-dead alias).
      if (err instanceof ModelDeprecatedError) {
        if (isMountedRef.current) setApiKeyError(err.message)
        return
      }

      let errorMsg = "Oops! Leo got a little confused. Let's try again! 🦁"

      if (err instanceof SafetyError) {
        errorMsg = SAFE_DEFLECTION
      } else if (err instanceof NetworkError) {
        const idx = Math.floor(Math.random() * FALLBACK_OFFLINE_RESPONSES.length)
        errorMsg = FALLBACK_OFFLINE_RESPONSES[idx]
      }

      if (!isMountedRef.current) return
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMsgId ? { ...m, text: errorMsg } : m
        )
      )
      await speakAndTrack(errorMsg, replyLang)
      if (isMountedRef.current) setLeoMood('happy')
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
        setLeoMood('happy')
      }
    }
  }, [isLoading, isOnline, geminiClient, systemPrompt, lang, profile, addSessionTopic, speakAndTrack])

  // Update ref whenever handleUserMessage changes
  useEffect(() => {
    handleUserMessageRef.current = handleUserMessage
  }, [handleUserMessage])

  // ── Audio capture path (non-English) ────────────────────────────────────
  //
  // For Hindi/Tamil/Kannada/Telugu the browser's STT is unreliable, so we
  // bypass it: record the kid's voice with MediaRecorder, send the audio
  // blob straight to Gemini, and let it transcribe + respond in one shot.
  // The English path (Web Speech → text → Gemini) is unchanged.

  const handleUserAudio = useCallback(async (
    base64Audio: string,
    audioMimeType: string,
    spokenLang: AppLang
  ) => {
    if (!geminiClient || !systemPrompt) return
    if (isLoading) return
    stopSpeaking()
    idleTimerRef.current?.reset()

    if (!isMountedRef.current) return
    // Pseudo user message — we don't have the transcript (that's the whole
    // point), so render a 🎙️ chip in the conversation history.
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: `🎙️ ${LANG_NAME[spokenLang]}`,
      timestamp: Date.now()
    }
    setMessages(prev => [...prev.slice(-9), userMsg])

    const assistantMsgId = crypto.randomUUID()
    setMessages(prev => [
      ...prev.slice(-9),
      { id: assistantMsgId, role: 'assistant', text: '', timestamp: Date.now() }
    ])
    setIsLoading(true)
    setLeoMood('thinking')

    const instructionPrefix =
      `The child spoke the attached audio in ${LANG_NAME[spokenLang]}. ` +
      `Transcribe what they said internally, then answer the child in ${LANG_NAME[spokenLang]} ` +
      `using its native script. Keep the reply short and natural for a ${profile?.age ?? 5}-year-old.`

    let fullResponse = ''
    let sentenceBuffer = ''
    try {
      await geminiClient.streamChatAudio(
        systemPrompt,
        base64Audio,
        audioMimeType,
        instructionPrefix,
        (chunk) => {
          if (!isMountedRef.current) return
          fullResponse += chunk
          sentenceBuffer += chunk
          setMessages(prev =>
            prev.map(m => m.id === assistantMsgId ? { ...m, text: fullResponse } : m)
          )
          const match = sentenceBuffer.match(/^(.+?[.!?])\s*/)
          if (match) {
            const sentence = match[1]
            sentenceBuffer = sentenceBuffer.slice(match[0].length)
            setLeoMood('excited')
            void speakAndTrack(sentence, spokenLang).then(() => {
              if (isMountedRef.current) setLeoMood('happy')
            })
          } else if (sentenceBuffer.length > 200) {
            void speakAndTrack(sentenceBuffer.trim(), spokenLang)
            sentenceBuffer = ''
          }
        }
      )
      if (sentenceBuffer.trim() && isMountedRef.current) {
        await speakAndTrack(sentenceBuffer.trim(), spokenLang)
      }
      if (!isMountedRef.current) return
      if (!fullResponse.trim()) {
        const emptyMsg = "Hmm, I didn't quite catch that! Can you say it again? 🦁"
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: emptyMsg } : m))
        await speakAndTrack(emptyMsg, spokenLang)
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      logEvent('error', `[Chat-audio] failed: ${errMsg}`, err)
      console.error('[Chat-audio] failed:', err)
      if (err instanceof ApiKeyError) {
        if (isMountedRef.current) setApiKeyError(err.message)
        return
      }
      if (err instanceof ModelDeprecatedError) {
        if (isMountedRef.current) setApiKeyError(err.message)
        return
      }
      let errorMsg = "Oops! Leo couldn't hear that clearly. Try again? 🦁"
      if (err instanceof SafetyError) errorMsg = SAFE_DEFLECTION
      else if (err instanceof NetworkError) {
        errorMsg = FALLBACK_OFFLINE_RESPONSES[Math.floor(Math.random() * FALLBACK_OFFLINE_RESPONSES.length)]
      }
      if (!isMountedRef.current) return
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: errorMsg } : m))
      await speakAndTrack(errorMsg, spokenLang)
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
        setLeoMood('happy')
      }
    }
  }, [geminiClient, systemPrompt, isLoading, profile, speakAndTrack])

  // Start/stop the audio recorder. Used by the mic button when the active
  // language is non-English. Resolves once Gemini has answered.
  const startAudioCapture = useCallback(async () => {
    if (isRecording) return
    const spokenLang = activeLang
    try {
      setIsRecording(true)
      const handle = await startRecording()
      recorderRef.current = handle
      const clip = await handle.done   // resolves on silence/timeout/manual stop
      recorderRef.current = null
      if (!isMountedRef.current) return
      setIsRecording(false)
      // Anything shorter than half a second is almost certainly mis-tap; skip.
      if (clip.durationMs < 500) return
      const b64 = await blobToBase64(clip.blob)
      await handleUserAudio(b64, clip.mimeType, spokenLang)
    } catch (err) {
      const name = (err as Error)?.name ?? ''
      if (name === 'NotAllowedError') {
        logEvent('error', '[Chat-audio] mic permission denied')
      } else {
        logEvent('error', `[Chat-audio] recorder failed: ${err instanceof Error ? err.message : String(err)}`, err)
      }
      if (isMountedRef.current) setIsRecording(false)
    }
  }, [isRecording, activeLang, handleUserAudio])

  const stopAudioCapture = useCallback(() => {
    if (recorderRef.current) {
      void recorderRef.current.stop()  // .done resolves inside startAudioCapture
    }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  // API key missing state
  if (apiKeyError) {
    return (
      <SafeArea className="bg-gradient-to-br from-lavender-50 to-leo-50">
        <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center">
          <LeoMascot size="lg" mood="thinking" />
          <div>
            <h2 className="text-2xl font-extrabold text-lavender-700">
              Leo needs his magic key! 🔑
            </h2>
            <p className="mt-2 text-base text-gray-600 font-medium">
              {typeof apiKeyError === 'string'
                ? apiKeyError
                : 'Ask a parent to set up the magic key first! ⚙️'}
            </p>
          </div>
          <button
            onClick={() => navigate('/settings')}
            className="px-8 py-4 bg-gradient-to-r from-lavender-500 to-lavender-700 text-white font-extrabold text-lg rounded-3xl shadow-lg active:scale-95"
          >
            Go to Settings ⚙️
          </button>
          <button
            onClick={() => navigate('/')}
            className="text-lavender-400 font-semibold"
          >
            ← Go back home
          </button>
        </div>
      </SafeArea>
    )
  }

  return (
    <SafeArea className="bg-gradient-to-b from-lavender-100 to-white" skipBottom>
      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-lavender-100">
          <button
            onClick={async () => {
              await handleSessionEnd()
              navigate('/')
            }}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <LeoMascot size="sm" mood={leoMood} speaking={isSpeaking} />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-extrabold text-lavender-700">
                {profile?.mascotChoice === 'lion' ? 'Leo' : profile?.mascotChoice === 'owl' ? 'Ollie' : 'Benny'}
              </p>
              {/* Live language indicator — shows what Leo is currently
                  hearing/speaking. Updates the moment the kid switches to
                  Hindi / Tamil / Kannada / Telugu / English. */}
              <span
                className="text-[10px] font-extrabold text-mint-700 bg-mint-50 border border-mint-200 px-1.5 py-0.5 rounded-full uppercase tracking-wider"
                aria-label={`Speaking ${LANG_NAME[activeLang]}`}
              >
                🌐 {activeLang}
              </span>
            </div>
            <p className="text-xs text-lavender-400 font-medium">
              {isLoading ? 'Thinking...'
                : isSpeaking ? 'Speaking...'
                : (isListening || isRecording) ? 'Listening...'
                : 'Ready to chat!'}
            </p>
          </div>
          {/* Safe Mode indicator */}
          <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full flex-shrink-0 flex items-center gap-1">
            🔒 Safe
          </span>
          {!isOnline && (
            <span className="text-xs font-bold text-orange-500 bg-orange-50 px-2 py-1 rounded-full">
              Offline
            </span>
          )}
        </div>

        {/* Messages list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 scrollbar-hide">
          {messages.length === 0 && !isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center pt-8 text-center gap-3"
            >
              <span className="text-5xl">👋</span>
              <p className="text-lg font-bold text-lavender-600">
                Hi {profile?.name}! Tap the mic and ask me anything!
              </p>
              <p className="text-sm text-gray-400 font-medium">
                Try: "Why is the sky blue?" or "Tell me about elephants!"
              </p>
            </motion.div>
          )}

          <AnimatePresence initial={false}>
            {messages.map(msg => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.25 }}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`
                    max-w-[80%] px-4 py-3 rounded-3xl text-base font-semibold leading-relaxed
                    ${msg.role === 'user'
                      ? 'bg-lavender-500 text-white rounded-br-lg'
                      : 'bg-white shadow-md text-gray-700 rounded-bl-lg border border-lavender-100'
                    }
                  `}
                >
                  {msg.text || (
                    // Loading dots while streaming
                    <span className="flex gap-1 items-center py-1">
                      {[0, 1, 2].map(i => (
                        <motion.span
                          key={i}
                          className="w-2 h-2 bg-lavender-300 rounded-full inline-block"
                          animate={{ y: [0, -5, 0] }}
                          transition={{ duration: 0.5, delay: i * 0.15, repeat: Infinity }}
                        />
                      ))}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          <div ref={messagesEndRef} />
        </div>

        {/* Transcript toggle */}
        <div className="px-4 pb-1">
          <button
            onClick={() => setShowTranscript(p => !p)}
            className="text-xs text-lavender-400 font-semibold"
          >
            {showTranscript ? '▼ Hide transcript' : '▶ Show transcript'}
          </button>

          <AnimatePresence>
            {showTranscript && (interimTranscript || transcript) && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-1 px-3 py-2 bg-lavender-50 rounded-xl text-sm text-lavender-600">
                  {interimTranscript && (
                    <span className="opacity-60 italic">{interimTranscript}</span>
                  )}
                  {transcript && !interimTranscript && (
                    <span>{transcript}</span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Speech error */}
          {speechError && (
            <p className="text-xs text-red-400 font-medium mt-1 text-center">{speechError}</p>
          )}
        </div>

        {/* Bottom controls */}
        <div className="px-4 pb-safe flex flex-col items-center gap-2 bg-white/80 backdrop-blur-sm pt-3 border-t border-lavender-100">
          {/* Intent confirm chip — appears when Leo detected a navigation
              intent ("play a game", "tell me a story", etc). One tap to
              confirm, one to dismiss; nothing happens automatically. */}
          {pendingIntent && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.92 }}
              className="flex gap-2 w-full"
            >
              <button
                onClick={() => {
                  const path = pendingIntent.path
                  setPendingIntent(null)
                  stopSpeaking()
                  navigate(path)
                }}
                className="flex-1 py-3 px-4 rounded-2xl bg-gradient-to-r from-lavender-500 to-lavender-700 text-white font-extrabold text-base shadow-md active:scale-95"
              >
                {pendingIntent.confirmLabel}
              </button>
              <button
                onClick={() => setPendingIntent(null)}
                className="px-4 py-3 rounded-2xl bg-gray-100 text-gray-600 font-bold text-sm active:scale-95"
              >
                Not now
              </button>
            </motion.div>
          )}
          {!isSupported ? (
            <div className="py-4 text-center">
              <p className="text-sm text-gray-500 font-medium">
                Voice not supported in this browser. Try Chrome on Android or Safari on iOS.
              </p>
            </div>
          ) : (
            <VoiceButton
              // Hybrid routing: English uses Web Speech (fast/free/accurate);
              // Hindi/Tamil/Kannada/Telugu records audio and sends to Gemini
              // for proper multilingual recognition. activeLang updates on
              // every message, so the same button DTRT after a switch.
              isListening={activeLang === 'en' ? isListening : isRecording}
              onStart={() => {
                idleTimerRef.current?.reset()
                if (isSpeaking) {
                  stopSpeaking()
                  setIsSpeaking(false)
                }
                if (activeLang === 'en') {
                  startListening()
                } else {
                  void startAudioCapture()
                }
              }}
              onStop={() => {
                if (activeLang === 'en') stopListening()
                else stopAudioCapture()
              }}
              // Only block during the AI round-trip. Speaking is interruptible
              // (see onStart above) so the mic is always re-clickable.
              disabled={isLoading}
            />
          )}
        </div>

      </div>
    </SafeArea>
  )
}
