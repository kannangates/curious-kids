// Lightweight sound-effects engine using the Web Audio API.
// No audio asset files needed — all chimes are synthesised on the fly,
// so this adds ZERO bytes to the bundle and works fully offline.
//
// Respects a per-device mute flag stored in localStorage (`ck_sfx_muted`).

// ─── Singleton AudioContext (created lazily on first user gesture) ─────────────

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    // iOS/Safari suspends the context until a gesture resumes it
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

// ─── Mute control ───────────────────────────────────────────────────────────

const MUTE_KEY = 'ck_sfx_muted'

export function isSfxMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setSfxMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

// ─── Core tone player ─────────────────────────────────────────────────────────

interface Tone {
  freq: number
  /** start offset in seconds */
  start: number
  /** duration in seconds */
  dur: number
  type?: OscillatorType
  /** peak gain 0–1 */
  gain?: number
}

function playTones(tones: Tone[]): void {
  if (isSfxMuted()) return
  const audio = getCtx()
  if (!audio) return

  const now = audio.currentTime

  for (const t of tones) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = t.type ?? 'sine'
    osc.frequency.value = t.freq

    const peak = t.gain ?? 0.18
    const startAt = now + t.start
    const endAt = startAt + t.dur

    // Quick attack, smooth exponential release — avoids clicks
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(startAt)
    osc.stop(endAt + 0.02)
  }
}

// ─── Public sound effects ─────────────────────────────────────────────────────

/** Soft tap for button presses. */
export function playTap(): void {
  playTones([{ freq: 660, start: 0, dur: 0.08, type: 'triangle', gain: 0.12 }])
}

/** Gentle two-note "pop" for a successful action. */
export function playSuccess(): void {
  playTones([
    { freq: 523.25, start: 0,    dur: 0.12, type: 'sine', gain: 0.16 }, // C5
    { freq: 783.99, start: 0.10, dur: 0.16, type: 'sine', gain: 0.16 }  // G5
  ])
}

/** Rising arpeggio celebration for XP / level-up / correct quiz answer. */
export function playCelebration(): void {
  playTones([
    { freq: 523.25, start: 0,    dur: 0.14, type: 'sine', gain: 0.16 }, // C5
    { freq: 659.25, start: 0.12, dur: 0.14, type: 'sine', gain: 0.16 }, // E5
    { freq: 783.99, start: 0.24, dur: 0.14, type: 'sine', gain: 0.16 }, // G5
    { freq: 1046.5, start: 0.36, dur: 0.26, type: 'sine', gain: 0.18 }  // C6
  ])
}

/** Soft descending "aww" for a wrong answer — never harsh. */
export function playOops(): void {
  playTones([
    { freq: 392.0,  start: 0,    dur: 0.14, type: 'triangle', gain: 0.14 }, // G4
    { freq: 311.13, start: 0.12, dur: 0.20, type: 'triangle', gain: 0.14 }  // Eb4
  ])
}
