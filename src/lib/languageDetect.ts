// Lightweight script-based language detector.
//
// We only need to distinguish the 5 languages the app supports
// (en / hi / kn / ta / te), and each of the four non-English ones uses
// a distinct Unicode script block. That makes detection essentially
// free — no model, no library, no network.
//
//   Devanagari  U+0900..U+097F   → Hindi
//   Bengali     U+0980..U+09FF   → (not enabled, but recognised for safety)
//   Tamil       U+0B80..U+0BFF   → Tamil
//   Telugu      U+0C00..U+0C7F   → Telugu
//   Kannada     U+0C80..U+0CFF   → Kannada
//
// Latin / digits / punctuation default to English.
//
// We count characters per script and pick the dominant one. This handles
// mixed input ("ammaa is sleeping" — mostly Latin → en; "tell me about
// ಆನೆ please" — Kannada chars present → kn) by leaning toward whichever
// non-English script appears, because the kid is signalling they want
// Leo to respond in that language even if a few English words leaked in.

import type { AppLang } from './langs'

interface ScriptRange {
  lang: AppLang
  test: (codePoint: number) => boolean
}

const SCRIPTS: ScriptRange[] = [
  { lang: 'hi', test: cp => cp >= 0x0900 && cp <= 0x097F },  // Devanagari
  { lang: 'ta', test: cp => cp >= 0x0B80 && cp <= 0x0BFF },  // Tamil
  { lang: 'te', test: cp => cp >= 0x0C00 && cp <= 0x0C7F },  // Telugu
  { lang: 'kn', test: cp => cp >= 0x0C80 && cp <= 0x0CFF },  // Kannada
]

/**
 * Detects the dominant non-Latin script in the text.
 * Returns null when the text is entirely Latin/whitespace/punctuation,
 * letting the caller fall back to whatever language was active before.
 */
export function detectLanguage(text: string): AppLang | null {
  if (!text) return null
  const counts: Partial<Record<AppLang, number>> = {}
  let latinLetters = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp == null) continue
    let matched = false
    for (const s of SCRIPTS) {
      if (s.test(cp)) {
        counts[s.lang] = (counts[s.lang] ?? 0) + 1
        matched = true
        break
      }
    }
    if (!matched && ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A))) {
      latinLetters += 1
    }
  }

  // Pick the script with the most characters. A SINGLE non-Latin character
  // is enough to switch — the kid clearly wants that language back.
  const entries = Object.entries(counts) as Array<[AppLang, number]>
  if (entries.length === 0) {
    return latinLetters > 0 ? 'en' : null
  }
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

/**
 * Like detectLanguage but always returns *something* — falls back to the
 * given default when the text is pure punctuation / digits.
 */
export function detectLanguageOr(text: string, fallback: AppLang): AppLang {
  return detectLanguage(text) ?? fallback
}
