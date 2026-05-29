// Tiny MediaRecorder wrapper for the audio-to-Gemini path.
//
// Used only when the active language is non-English (Hindi / Tamil / Kannada
// / Telugu) — the device's Web Speech API does English fine but is unreliable
// for Indian languages, and Gemini's multimodal models recognise them very
// accurately. See ChatScreen.handleUserAudio for the call site.
//
// We deliberately cap recording at 15s so a kid who forgets to release the
// mic doesn't shovel a minute of "uhmmmm" into the API. 15s is also well
// within Gemini's inlineData 20 MB / per-request limits (~32 tokens/sec
// audio → 15s = ~480 tokens, peanuts).

const MAX_RECORDING_MS = 15_000
// Auto-stop after this much continuous silence once the kid has been heard
// at least briefly. Mirrors the Web Speech "POST_SPEECH_TIMEOUT_MS" feel.
const SILENCE_MS = 1_400
// How long to wait for the FIRST sound before giving up.
const FIRST_SOUND_TIMEOUT_MS = 8_000
// Volume floor below which we treat the mic input as silence. Calibrated
// for kid voices on laptop/phone mics — true silence reads ~0.01-0.02.
const SILENCE_FLOOR = 0.045

export interface RecordedClip {
  /** The full recording as a Blob — pass straight to Gemini analyseAudio. */
  blob: Blob
  /** MIME type of the recording (audio/webm, audio/mp4, etc). */
  mimeType: string
  /** How long the recording is, in ms. */
  durationMs: number
}

export interface RecorderHandle {
  /** Stop early (used when the kid taps the mic again). Resolves with the clip. */
  stop: () => Promise<RecordedClip>
  /**
   * Promise that resolves when recording ends — either by silence timeout,
   * the 15s cap, or an explicit stop(). Rejects on permission / hardware error.
   */
  done: Promise<RecordedClip>
}

/** Pick a MIME type the current browser actually supports. */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  // Order matters — Safari only ships audio/mp4, Chrome prefers webm/opus.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t } catch { /* ignore */ }
  }
  return ''
}

/**
 * Begin recording from the device microphone. Returns immediately with a
 * handle whose `.done` resolves when recording ends (silence/timeout/manual
 * stop). The caller doesn't need to attach onstop listeners.
 *
 * Errors:
 *  - NotAllowedError → mic permission denied
 *  - NotFoundError   → no microphone hardware
 *  - "MediaRecorder not supported" → very old browsers
 */
export async function startRecording(): Promise<RecorderHandle> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder not supported on this browser')
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = pickMimeType()
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)

  const chunks: Blob[] = []
  const start = Date.now()
  let stopped = false

  // Audio-level analyser for silence detection. AudioContext is async to
  // create on some browsers, so we just guard each frame.
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let rafId = 0
  let lastLoudAt = 0
  let everLoud = false
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext
    if (Ctx) {
      audioCtx = new Ctx()
      const src = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
    }
  } catch { /* ignore — fall back to time-based stop only */ }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }

  const finished: Promise<RecordedClip> = new Promise((resolve, reject) => {
    recorder.onerror = (e) => {
      cleanup()
      reject((e as any)?.error ?? new Error('Recording failed'))
    }
    recorder.onstop = () => {
      cleanup()
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
      resolve({
        blob,
        mimeType: blob.type || 'audio/webm',
        durationMs: Date.now() - start,
      })
    }
  })

  function cleanup(): void {
    cancelAnimationFrame(rafId)
    try { stream.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    try { audioCtx?.close() } catch { /* ignore */ }
  }

  function tick(): void {
    if (stopped) return
    rafId = requestAnimationFrame(tick)
    const now = Date.now()

    // Hard cap — 15s of audio is plenty for a kid prompt.
    if (now - start >= MAX_RECORDING_MS) {
      stopInternal()
      return
    }

    // No-sound timeout — give up if we never heard anything.
    if (!everLoud && now - start >= FIRST_SOUND_TIMEOUT_MS) {
      stopInternal()
      return
    }

    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteTimeDomainData(data)
      // RMS in [0,1] range. Byte data is 0..255, centred at 128.
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / data.length)
      if (rms > SILENCE_FLOOR) {
        lastLoudAt = now
        everLoud = true
      }
      // After we've heard sound, stop when there's been a long enough pause.
      if (everLoud && now - lastLoudAt >= SILENCE_MS) {
        stopInternal()
        return
      }
    }
  }

  function stopInternal(): void {
    if (stopped) return
    stopped = true
    try { recorder.stop() } catch { /* already stopped */ }
  }

  recorder.start(250)  // dataavailable every 250 ms — small chunks, easy concat
  rafId = requestAnimationFrame(tick)

  return {
    stop: () => { stopInternal(); return finished },
    done: finished,
  }
}

/** Base64-encodes a Blob for Gemini inlineData. Strips the data:URL prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}
