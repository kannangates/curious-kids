import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { db, getRecentSummaries } from '../db/index'
import { useAppStore } from '../store/app'
import { decryptApiKey } from '../lib/crypto'
import { createGeminiClient, SafetyError, NetworkError, ApiKeyError, type GeminiClient } from '../lib/gemini'
import { speak, stopSpeaking } from '../lib/voice'
import { checkInput, checkOutput, SAFE_DEFLECTION } from '../lib/safety'
import { createIdleTimer, generateSessionSummary, initSessionTriggers, type IdleTimer } from '../lib/session'
import { extractTopics, bumpInterest, getTopInterests } from '../lib/memory'
import { getLocalAnswer } from '../lib/localAnswers'
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const idleTimerRef = useRef<IdleTimer | null>(null)
  const isMountedRef = useRef(true)
  const hasEndedRef = useRef(false)
  const pendingSpeakRef = useRef<Promise<void> | null>(null)
  const qParamHandledRef = useRef(false)
  const handleUserMessageRef = useRef<(text: string) => Promise<void> | void>()
  const lang = profile?.preferredLanguages[0] ?? 'en'

  const { transcript, interimTranscript, isListening, startListening, stopListening, error: speechError, isSupported } = useSpeech(lang)

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
    return () => { isMountedRef.current = false }
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

        // Build system prompt using top interests from memory module
        const topInterests = await getTopInterests(profile.id, 3)
        const recentSummaries = await getRecentSummaries(profile.id, 2)
        const prompt = buildSystemPrompt(
          profile,
          topInterests.map(t => t.tag),
          recentSummaries.map(s => s.summary)
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
    const p = speak(text, language).then(() => {
      if (isMountedRef.current) setIsSpeaking(false)
    }).catch(() => {
      if (isMountedRef.current) setIsSpeaking(false)
    })
    pendingSpeakRef.current = p
    return p
  }, [])

  // ── Send message to Gemini ─────────────────────────────────────────────────

  const handleUserMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return

    // Fix 26: stop any ongoing speech and reset before processing new message
    stopSpeaking()

    idleTimerRef.current?.reset()

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
      await speakAndTrack(SAFE_DEFLECTION, lang)
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
      await speakAndTrack(local, lang)
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
      await speakAndTrack(fallback, lang)
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

    try {
      await geminiClient.streamChat(
        systemPrompt,
        text,
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

          // Speak complete sentences as they arrive
          const sentenceMatch = sentenceBuffer.match(/^(.+?[.!?])\s*/)
          if (sentenceMatch) {
            const sentence = sentenceMatch[1]
            sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length)
            setLeoMood('excited')
            void speakAndTrack(sentence, lang).then(() => {
              if (isMountedRef.current) setLeoMood('happy')
            })
          } else if (sentenceBuffer.length > 200) {
            // Fix 7: fallback for long buffers with no punctuation
            void speakAndTrack(sentenceBuffer.trim(), lang)
            sentenceBuffer = ''
          }
        }
      )

      // Speak any remaining buffer
      if (sentenceBuffer.trim()) {
        if (isMountedRef.current) {
          await speakAndTrack(sentenceBuffer.trim(), lang)
        }
      }

      if (!isMountedRef.current) return

      // Empty response (e.g. model returned no usable text) — don't leave the
      // bubble stuck on loading dots; give a friendly nudge.
      if (!fullResponse.trim()) {
        const emptyMsg = "Hmm, I didn't quite catch that! Can you ask me again? 🦁"
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: emptyMsg } : m))
        await speakAndTrack(emptyMsg, lang)
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
        await speakAndTrack(safeMsg, lang)
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
      // Surface the real error for diagnostics (UI stays kid-friendly)
      console.error('[Chat] message failed:', err)

      // Invalid API key → show the dedicated key-setup screen (has Settings link)
      if (err instanceof ApiKeyError) {
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
      await speakAndTrack(errorMsg, lang)
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
            <p className="font-extrabold text-lavender-700">
              {profile?.mascotChoice === 'lion' ? 'Leo' : profile?.mascotChoice === 'owl' ? 'Ollie' : 'Benny'}
            </p>
            <p className="text-xs text-lavender-400 font-medium">
              {isLoading ? 'Thinking...' : isSpeaking ? 'Speaking...' : isListening ? 'Listening...' : 'Ready to chat!'}
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
          {!isSupported ? (
            <div className="py-4 text-center">
              <p className="text-sm text-gray-500 font-medium">
                Voice not supported in this browser. Try Chrome on Android or Safari on iOS.
              </p>
            </div>
          ) : (
            <VoiceButton
              isListening={isListening}
              onStart={() => {
                idleTimerRef.current?.reset()
                startListening()
              }}
              onStop={stopListening}
              disabled={isLoading || isSpeaking}
            />
          )}
        </div>

      </div>
    </SafeArea>
  )
}
