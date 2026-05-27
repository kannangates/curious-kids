// Content safety filter for child-appropriate interactions.
// Conservative approach: only block clear adult/harmful topics,
// not context-free words that children might legitimately use.

// ─── Blocklist ────────────────────────────────────────────────────────────────

/**
 * Adult/harmful keywords to block in user input.
 * Kept conservative — "shooting star", "dead flowers", "kill" in game context
 * should NOT be blocked. Only explicit adult content is listed here.
 */
export const INPUT_BLOCKLIST: string[] = [
  // Explicit sexual content
  'porn',
  'pornography',
  'xxx',
  'nude',
  'nudity',
  'naked',
  'sex',
  'sexual',
  // Violence / weapons (explicit)
  'weapon',
  'bomb',
  'explosive',
  'terrorist',
  'terrorism',
  'murder',
  // Drugs / substances
  'cocaine',
  'heroin',
  'meth',
  'marijuana',
  'weed',
  'drugs',
  'alcohol',
  // Self-harm
  'suicide',
  'self-harm',
  'cut myself',
  // Hate
  'racist',
  'nigger',
  'faggot'
]

// Pre-build a regex for efficient matching
// Uses word boundaries to avoid false positives on substrings
const buildBlocklistRegex = (list: string[]): RegExp => {
  const escaped = list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i')
}

const INPUT_BLOCKLIST_REGEX = buildBlocklistRegex(INPUT_BLOCKLIST)

// Output also checked for any blocklisted content
const OUTPUT_BLOCKLIST: string[] = [
  ...INPUT_BLOCKLIST,
  // Additional output-only checks
  'adult content',
  'explicit',
  'inappropriate'
]

const OUTPUT_BLOCKLIST_REGEX = buildBlocklistRegex(OUTPUT_BLOCKLIST)

// ─── Deflection message ───────────────────────────────────────────────────────

export const SAFE_DEFLECTION =
  "That's a question for your parents! Let's explore something fun — what animals do you like? 🦁"

// ─── Check functions ──────────────────────────────────────────────────────────

/**
 * Returns true if the input text is SAFE for a child to send.
 * Returns false if any blocklisted content is detected.
 */
export function checkInput(text: string): boolean {
  if (!text || typeof text !== 'string') return true
  return !INPUT_BLOCKLIST_REGEX.test(text)
}

/**
 * Returns true if the output text from Gemini is SAFE to show/speak to a child.
 * Returns false if any blocklisted content is detected.
 */
export function checkOutput(text: string): boolean {
  if (!text || typeof text !== 'string') return true
  return !OUTPUT_BLOCKLIST_REGEX.test(text)
}
