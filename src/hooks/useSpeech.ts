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
 * - Auto-stops after 2 seconds of silence
 * - Cleans up recognition on unmount
 */
export function useSpeech(lang = 'en'): UseSpeechReturn {
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<any | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSupported = getSpeechRecognition() !== null

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  const resetSilenceTimer = useCallback((recognition: any) => {
    clearSilenceTimer()
    silenceTimerRef.current = setTimeout(() => {
      // 2 seconds of silence — stop listening
      recognition.stop()
    }, 2000)
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
        setTranscript(prev => (prev + ' ' + finalText).trim())
        setInterimTranscript('')
        // Reset silence timer when we get final results
        resetSilenceTimer(recognition)
      }

      if (interimText) {
        setInterimTranscript(interimText)
        // Reset silence timer on interim results too
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
