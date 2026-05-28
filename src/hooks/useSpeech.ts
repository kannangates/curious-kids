import { useState, useEffect, useRef, useCallback } from 'react'
import { getSpeechRecognition, LANG_MAP } from '../lib/voice'

interface UseSpeechReturn {
  transcript: string
  interimTranscript: string
  isListening: boolean
  startListening: () => void
  stopListening: () => void
  error: string | null
  isSupported: boolean
}

/**
 * React hook for speech recognition.
 * - continuous: false (single utterance mode)
 * - interimResults: true (shows partial results)
 * - Kid-patient silence timeouts: longer wait BEFORE first speech, shorter
 *   between phrases — so a child can take a beat to think and still finish.
 * - Cleans up recognition on unmount
 */

// Patient timing for kids who speak slowly / in broken phrases.
const FIRST_SPEECH_TIMEOUT_MS = 8000  // up to 8s to *start* speaking
const POST_SPEECH_TIMEOUT_MS  = 4000  // up to 4s between phrases once speaking

export function useSpeech(lang = 'en'): UseSpeechReturn {
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<any | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasSpokenRef = useRef(false) // becomes true once we hear any speech
  const isSupported = getSpeechRecognition() !== null

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  const resetSilenceTimer = useCallback((recognition: any) => {
    clearSilenceTimer()
    const ms = hasSpokenRef.current ? POST_SPEECH_TIMEOUT_MS : FIRST_SPEECH_TIMEOUT_MS
    silenceTimerRef.current = setTimeout(() => {
      recognition.stop()
    }, ms)
  }, [clearSilenceTimer])

  const stopListening = useCallback(() => {
    clearSilenceTimer()
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // Ignore errors from stopping already-stopped recognition
      }
    }
    setIsListening(false)
    setInterimTranscript('')
  }, [clearSilenceTimer])

  const startListening = useCallback(() => {
    if (!isSupported) {
      setError('Speech recognition is not supported in this browser')
      return
    }

    // Clean up any existing instance before creating a new one
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch { /* ignore */ }
      recognitionRef.current = null
    }

    const recognition = getSpeechRecognition()
    if (!recognition) {
      setError('Could not initialize speech recognition')
      return
    }

    recognitionRef.current = recognition
    setError(null)
    setTranscript('')
    setInterimTranscript('')
    hasSpokenRef.current = false  // fresh listen → use the longer "first speech" timeout

    // Configure recognition
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = LANG_MAP[lang] ?? lang
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsListening(true)
      resetSilenceTimer(recognition)
    }

    recognition.onresult = (event: any) => {
      let finalText = ''
      let interimText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText += result[0].transcript
        } else {
          interimText += result[0].transcript
        }
      }

      if (finalText) {
        hasSpokenRef.current = true
        setTranscript(prev => (prev + ' ' + finalText).trim())
        setInterimTranscript('')
        resetSilenceTimer(recognition)
      }

      if (interimText) {
        hasSpokenRef.current = true
        setInterimTranscript(interimText)
        resetSilenceTimer(recognition)
      }
    }

    recognition.onspeechend = () => {
      // Speech ended — start silence timer
      resetSilenceTimer(recognition)
    }

    recognition.onend = () => {
      clearSilenceTimer()
      setIsListening(false)
      setInterimTranscript('')
    }

    recognition.onerror = (event: any) => {
      clearSilenceTimer()
      setIsListening(false)
      setInterimTranscript('')

      switch (event.error) {
        case 'not-allowed':
          setError('Microphone access was denied. Please allow microphone access in your browser settings.')
          break
        case 'no-speech':
          // Not a real error — just silence
          setError(null)
          break
        case 'network':
          setError('Network error during speech recognition. Please check your connection.')
          break
        case 'aborted':
          // User or programmatic abort — not an error
          setError(null)
          break
        default:
          setError(`Speech recognition error: ${event.error}`)
      }
    }

    try {
      recognition.start()
    } catch (err) {
      setError(`Could not start speech recognition: ${err instanceof Error ? err.message : String(err)}`)
      setIsListening(false)
    }
  }, [isSupported, lang, resetSilenceTimer, clearSilenceTimer])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilenceTimer()
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch {
          // Ignore cleanup errors
        }
        recognitionRef.current = null
      }
    }
  }, [clearSilenceTimer])

  return {
    transcript,
    interimTranscript,
    isListening,
    startListening,
    stopListening,
    error,
    isSupported
  }
}
