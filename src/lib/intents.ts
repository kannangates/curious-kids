// Voice intent router — runs locally on every utterance before we hit
// Gemini, so simple "play a game" / "tell me a story" / "what is this"
// phrasings short-circuit into a navigation suggestion instead of a chat
// reply. We keep it ultra-conservative: many small triggers, but only one
// keyword needs to match. The kid sees a confirm chip ("Yes!"/"Not now")
// so accidental matches never auto-navigate.

export type IntentKind =
  | 'camera'      // /camera
  | 'puzzle'      // /puzzle
  | 'wordgame'    // /wordgame
  | 'bedtime'     // /bedtime
  | 'words'       // /words (Word Explorer)
  | 'discoveries' // /discoveries

export interface Intent {
  kind: IntentKind
  /** Path to navigate to on confirm. */
  path: string
  /** Friendly prompt to ask the kid back. */
  prompt: string
  /** Short label for the confirm chip. */
  confirmLabel: string
}

// Keyword tables, lowercase. Each list is matched as a substring against
// the lowercased utterance. We deliberately use loose phrasings kids use.
const INTENT_KEYWORDS: Record<IntentKind, string[]> = {
  camera: [
    'what is this', "what's this", 'whats this', 'see this',
    'look at this', 'identify this', 'take a picture', 'take a photo',
    'use the camera', 'open camera', 'camera', 'photo'
  ],
  puzzle: [
    'puzzle', 'riddle', 'brain teaser', 'guess what', 'guessing game'
  ],
  wordgame: [
    'play a game', 'play game', "let's play", 'word game', 'word match',
    'match words', 'matching game', 'play match'
  ],
  bedtime: [
    'bedtime story', 'tell me a story', 'read me a story', 'story time',
    'storytime', 'read a story', 'tell a story', 'goodnight story',
    'sleep story'
  ],
  words: [
    'word explorer', 'learn a word', 'new word', 'translate', 'how do you say',
    'what does .* mean', 'word in', 'in kannada', 'in hindi', 'in tamil', 'in telugu'
  ],
  discoveries: [
    'my discoveries', 'show my discoveries', 'what did i learn',
    'what have i learned', 'show me what i learned', 'my collection'
  ],
}

const INTENT_PROMPTS: Record<IntentKind, { prompt: string; confirmLabel: string; path: string }> = {
  camera: {
    prompt: "Want me to open the camera so I can see it? 📷",
    confirmLabel: "Yes, open camera!",
    path: '/camera',
  },
  puzzle: {
    prompt: "Ooh, a puzzle? Shall I open Puzzle Time? 🧩",
    confirmLabel: "Yes, let's puzzle!",
    path: '/puzzle',
  },
  wordgame: {
    prompt: "Let's play Word Match! Want me to start it? 🎮",
    confirmLabel: "Yes, play!",
    path: '/wordgame',
  },
  bedtime: {
    prompt: "A bedtime story sounds lovely. Open Bedtime Story Mode? 🌙",
    confirmLabel: "Yes, story time!",
    path: '/bedtime',
  },
  words: {
    prompt: "Want to open Word Explorer to learn that word? 📚",
    confirmLabel: "Yes!",
    path: '/words',
  },
  discoveries: {
    prompt: "Want to see your Discoveries collection? ✨",
    confirmLabel: "Yes!",
    path: '/discoveries',
  },
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Detect a navigation intent in the kid's utterance. Returns null when
 * nothing matches (continue with normal chat).
 *
 * Priority is the declaration order in INTENT_KEYWORDS — earlier kinds
 * win when an utterance ambiguously hits two. That order is tuned so
 * "tell me a story about a puzzle" still routes to bedtime, etc.
 */
export function detectIntent(rawText: string): Intent | null {
  const t = normalise(rawText)
  if (!t) return null

  for (const kind of Object.keys(INTENT_KEYWORDS) as IntentKind[]) {
    const matched = INTENT_KEYWORDS[kind].some(kw => {
      if (kw.includes('.*')) {
        try { return new RegExp(`\\b${kw}\\b`).test(t) } catch { return false }
      }
      return t.includes(kw)
    })
    if (matched) {
      const meta = INTENT_PROMPTS[kind]
      return { kind, path: meta.path, prompt: meta.prompt, confirmLabel: meta.confirmLabel }
    }
  }
  return null
}
