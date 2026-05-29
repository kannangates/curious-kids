// Voice library: wraps SpeechSynthesis and SpeechRecognition APIs
// with kid-friendly settings (slower rate, higher pitch).

// ─── Language map ─────────────────────────────────────────────────────────────

export const LANG_MAP: Record<string, string> = {
  en: 'en-IN',
  kn: 'kn-IN',
  hi: 'hi-IN',
  ta: 'ta-IN',
  te: 'te-IN'
}

// ─── Support detection ────────────────────────────────────────────────────────

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

// ─── Mobile TTS priming ─────────────────────────────────────────────────────
// iOS Safari (and some Android browsers) silently block speechSynthesis.speak()
// until the page has received a real user gesture. Without this priming, the
// Home greeting / chat responses simply produce no sound on mobile.
//
// We listen for the very first touch/click and fire a 1-character whisper so
// the audio context is "unlocked" for the rest of the session. The whisper is
// near-silent (volume 0.01) so the user never notices.

let speechPrimed = false

export function isSpeechPrimed(): boolean { return speechPrimed }

export function primeSpeechOnGesture(): void {
  if (speechPrimed || !isSpeechSupported() || typeof window === 'undefined') return

  function prime() {
    if (speechPrimed) return
    speechPrimed = true
    try {
      // iOS WebKit / Brave: the priming utterance MUST be allowed to actually
      // start (and not be immediately cancelled) for the audio session to be
      // unlocked for subsequent non-gesture speech. Use a real (but inaudible)
      // utterance and let it finish naturally — much more reliable than the
      // older "speak then cancel" approach.
      const u = new SpeechSynthesisUtterance('.')
      u.volume = 0.001
      u.rate = 2
      u.lang = 'en-US'
      // Don't await voiceschanged here — even a default-voice utterance is
      // enough to unlock the session.
      window.speechSynthesis.speak(u)
    } catch { /* ignore */ }
    window.removeEventListener('touchstart', prime)
    window.removeEventListener('pointerdown', prime)
    window.removeEventListener('keydown', prime)
  }

  window.addEventListener('touchstart', prime, { once: true, passive: true })
  window.addEventListener('pointerdown', prime, { once: true, passive: true })
  window.addEventListener('keydown', prime, { once: true })
}

// ─── Preferred-voice override (parent-chosen, per device) ──────────────────────

const PREF_VOICE_KEY = 'ck_voice_uri'

export function getPreferredVoiceURI(): string | null {
  try { return localStorage.getItem(PREF_VOICE_KEY) } catch { return null }
}

export function setPreferredVoiceURI(uri: string | null): void {
  try {
    if (uri) localStorage.setItem(PREF_VOICE_KEY, uri)
    else localStorage.removeItem(PREF_VOICE_KEY)
  } catch { /* ignore */ }
}

/**
 * Safely reads the list of voices. Brave (and some privacy extensions) wrap
 * `speechSynthesis.getVoices()` with a "fake voice" shim that can return
 * objects which throw on `Object.getPrototypeOf(v)` or where `.name`/`.lang`
 * is undefined. We catch + filter so a single bad entry can't break TTS.
 */
function safeGetVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return []
  let raw: SpeechSynthesisVoice[] = []
  try { raw = window.speechSynthesis.getVoices() ?? [] } catch { return [] }
  return raw.filter(v => {
    try {
      return !!v && typeof v.name === 'string' && typeof v.lang === 'string'
    } catch { return false }
  })
}

/** All voices that can speak the given app language (for a settings picker). */
export function getVoicesForLang(lang: string): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return []
  const prefix = (LANG_MAP[lang] ?? lang).split('-')[0].toLowerCase()
  const voices = safeGetVoices()
  const matches = voices.filter(v => {
    try { return v.lang.toLowerCase().startsWith(prefix) } catch { return false }
  })
  return matches.sort((a, b) => scoreVoice(b, lang) - scoreVoice(a, lang))
}

// ─── Voice selection ──────────────────────────────────────────────────────────

/**
 * Scores a voice for naturalness + language fit. Higher = better.
 * The big win for "human-like" sound: strongly prefer Natural / Neural / Online
 * / Google voices and avoid the old robotic desktop / eSpeak voices.
 */
function scoreVoice(v: SpeechSynthesisVoice, lang: string): number {
  // Brave's anti-fingerprint shim can produce voice objects that throw on
  // property access. Wrap the whole thing so a single bad voice can't tank
  // the picker / greeting.
  try {
    const bcp47 = LANG_MAP[lang] ?? lang
    const prefix = bcp47.split('-')[0].toLowerCase()
    const name = (v?.name ?? '').toLowerCase()
    const vlang = (v?.lang ?? '').toLowerCase()
    let s = 0

    // Language fit
    if (vlang && vlang === bcp47.toLowerCase()) s += 60
    else if (vlang && vlang.startsWith(prefix)) s += 35

    // Quality markers (free, high-quality neural/cloud voices)
    if (name.includes('natural')) s += 45      // Edge "… Online (Natural)"
    if (name.includes('neural')) s += 42
    if (name.includes('google')) s += 38       // Chrome cloud voices
    if (name.includes('online')) s += 22
    if (name.includes('siri')) s += 30          // Apple
    if (name.includes('premium') || name.includes('enhanced')) s += 25
    try { if (v?.localService === false) s += 12 } catch { /* shim threw */ }

    // Robotic / low-quality markers
    if (name.includes('desktop')) s -= 30       // old Windows SAPI voices
    if (name.includes('espeak')) s -= 40
    if (name.includes('compact')) s -= 12

    return s
  } catch {
    return -1000  // unusable
  }
}

/**
 * Picks the best available voice for the given language code.
 * 1) honours a parent-chosen voice, 2) otherwise scores for naturalness.
 */
function selectVoice(lang: string): SpeechSynthesisVoice | null {
  if (!isSpeechSupported()) return null
  const voices = safeGetVoices()
  if (voices.length === 0) return null

  // 1. Parent-chosen voice (if still available)
  const prefUri = getPreferredVoiceURI()
  if (prefUri) {
    const chosen = voices.find(v => {
      try { return v.voiceURI === prefUri } catch { return false }
    })
    if (chosen) return chosen
  }

  // 2. Score all voices for this language; fall back to English if none match
  const bcp47 = LANG_MAP[lang] ?? lang
  const prefix = bcp47.split('-')[0].toLowerCase()
  const langMatches = (p: string) =>
    voices.filter(v => {
      try { return (v.lang ?? '').toLowerCase().startsWith(p) } catch { return false }
    })
  let pool = langMatches(prefix)
  if (pool.length === 0) pool = langMatches('en')
  if (pool.length === 0) pool = voices

  return pool
    .map(v => ({ v, score: scoreVoice(v, lang) }))
    .sort((a, b) => b.score - a.score)[0]?.v ?? null
}

// ─── Core speak function ──────────────────────────────────────────────────────

interface SpeakOptions {
  rate?: number
  pitch?: number
  lang?: string
  voiceURI?: string  // force a specific voice (used for previews)
}

function speakWithOptions(text: string, options: SpeakOptions): Promise<void> {
  // NOTE: this promise NEVER rejects — every failure path (synth error, Brave
  // shield, watchdog timeout) resolves so the caller's UI state can't get
  // stuck. The reason is captured to the debug log instead.
  return new Promise((resolve) => {
    if (!isSpeechSupported()) { resolve(); return }

    window.speechSynthesis.cancel()

    if (!text.trim()) { resolve(); return }

    // Create the utterance and actually call speak() only after voices are confirmed
    // loaded. Assigning utterance.voice *before* speak() is the only reliable way.
    function doSpeak() {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = options.rate ?? 0.85
      utterance.pitch = options.pitch ?? 1.1
      utterance.volume = 1.0

      // Honour an explicit voiceURI (preview), else pick the best voice.
      // Route through safeGetVoices so a malformed shim voice can't throw here.
      let voice: SpeechSynthesisVoice | null = null
      if (options.voiceURI) {
        voice = safeGetVoices().find(v => {
          try { return v.voiceURI === options.voiceURI } catch { return false }
        }) ?? null
      }
      if (!voice) voice = selectVoice(options.lang ?? 'en')
      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang
      }

      // iOS Safari bug: synthesis can stall after ~15s — keep it alive
      const resumeInterval = setInterval(() => {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume()
      }, 5000)

      // Belt-and-braces watchdog: on iOS Brave / restrictive privacy shields
      // utterance.onend can simply never fire (TTS silently disabled). Without
      // a hard cap the speak() promise hangs forever, leaving isSpeaking stuck
      // true and the mic button permanently disabled. Cap the longest plausible
      // utterance: rough estimate 220 chars/sec at rate 1 → 8s buffer + length.
      const estDuration = Math.min(60_000, 4_000 + Math.ceil(text.length / (options.rate ?? 1)) * 80)
      const watchdog = setTimeout(() => {
        clearInterval(resumeInterval)
        try { window.speechSynthesis.cancel() } catch { /* ignore */ }
        resolve()
      }, estDuration)

      const finish = (fn: () => void) => {
        clearInterval(resumeInterval)
        clearTimeout(watchdog)
        fn()
      }

      utterance.onend = () => finish(resolve)
      utterance.onerror = (event) => {
        // Treat ALL synthesis errors as "speech is over" — never reject. The
        // caller is always async UI plumbing where a rejection would freeze
        // state (e.g. ChatScreen.isSpeaking sticking true and disabling mic).
        // The actual reason is captured to the debug log for diagnostics.
        try {
          if (event.error && event.error !== 'interrupted' && event.error !== 'canceled') {
            console.warn(`[voice] speech synthesis error: ${event.error}`)
          }
        } catch { /* ignore */ }
        finish(resolve)
      }

      try {
        window.speechSynthesis.speak(utterance)
      } catch (err) {
        // Brave's privacy shield can throw synchronously when TTS is blocked.
        // Same treatment as onerror — fail open, log, never freeze the UI.
        console.warn('[voice] speechSynthesis.speak threw:', err)
        finish(resolve)
      }
    }

    if (safeGetVoices().length > 0) {
      doSpeak()
    } else {
      // Voices haven't loaded yet (common on first call). Defer speak() until
      // voiceschanged fires, or fall back after 2s with whatever default is available.
      let settled = false

      const timeout = setTimeout(() => {
        if (!settled) { settled = true; doSpeak() }
      }, 2000)

      const onVoicesChanged = () => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged)
          doSpeak()
        }
      }

      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged)
    }
  })
}

/**
 * Speaks text at a lively, natural rate for children.
 * Cancels any ongoing speech first. (Rate a touch higher than before so the
 * delivery feels energetic and human rather than slow/robotic.)
 */
export function speak(text: string, lang = 'en'): Promise<void> {
  return speakWithOptions(text, { rate: 0.95, pitch: 1.15, lang })
}

/**
 * Speaks text at a slower rate — suitable for bedtime / learning mode.
 */
export function speakSlow(text: string, lang = 'en'): Promise<void> {
  return speakWithOptions(text, { rate: 0.8, pitch: 1.05, lang })
}

/**
 * Speaks a short sample with a SPECIFIC voice — used by the Settings voice picker
 * so a parent can hear each voice before choosing.
 */
export function previewVoice(text: string, lang: string, voiceURI: string): Promise<void> {
  return speakWithOptions(text, { rate: 0.95, pitch: 1.15, lang, voiceURI })
}

/**
 * Immediately stops any ongoing speech synthesis.
 */
export function stopSpeaking(): void {
  if (isSpeechSupported()) {
    window.speechSynthesis.cancel()
  }
}

/** Pauses ongoing speech (e.g. bedtime story). */
export function pauseSpeaking(): void {
  if (isSpeechSupported()) {
    try { window.speechSynthesis.pause() } catch { /* ignore */ }
  }
}

/** Resumes paused speech. */
export function resumeSpeaking(): void {
  if (isSpeechSupported()) {
    try { window.speechSynthesis.resume() } catch { /* ignore */ }
  }
}

// ─── Speech recognition ───────────────────────────────────────────────────────

type SpeechRecognitionCtor = new () => any

/**
 * Returns a SpeechRecognition instance, or null if not supported.
 * Handles the webkit-prefixed version for Safari/older Chrome.
 */
export function getSpeechRecognition(): any | null {
  if (typeof window === 'undefined') return null

  const SpeechRecognitionAPI: SpeechRecognitionCtor | undefined =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition

  if (!SpeechRecognitionAPI) return null

  try {
    return new SpeechRecognitionAPI()
  } catch {
    return null
  }
}
