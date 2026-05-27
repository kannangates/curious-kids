import type { ChildProfile } from '../db/index'

// ─── Master system prompt ─────────────────────────────────────────────────────

/**
 * Builds the full system prompt for Leo the AI companion.
 * Personalized with the child's profile, interests, and recent context.
 */
export function buildSystemPrompt(
  profile: ChildProfile,
  topInterests: string[],
  lastSummaries: string[]
): string {
  const mascotName = profile.mascotChoice === 'lion'
    ? 'Leo'
    : profile.mascotChoice === 'owl'
    ? 'Ollie'
    : 'Benny'

  const mascotEmoji = profile.mascotChoice === 'lion'
    ? '🦁'
    : profile.mascotChoice === 'owl'
    ? '🦉'
    : '🐰'

  // Each mascot has a distinct voice/personality so the child bonds with their choice
  const mascotPersona = profile.mascotChoice === 'lion'
    ? `You are a BRAVE, BOUNCY lion cub. You ROAR with excitement ("Roarrr!"), love adventure, and cheer the child on like a best friend on a treasure hunt. You're playful and full of energy.`
    : profile.mascotChoice === 'owl'
    ? `You are a WISE, GENTLE owl. You say "Hoo-hoo!" and love to wonder out loud ("Hmm, let me think..."). You're calm, thoughtful, and make the child feel clever for noticing things. You sprinkle in little "did you know" wonders.`
    : `You are a SOFT, GIGGLY bunny. You hop with joy ("Boing boing!"), giggle a lot ("Hehe!"), and are super sweet and cuddly. You make everything feel cozy, safe, and fun, like a warm hug.`

  const interestsSection = topInterests.length > 0
    ? `${profile.name}'s favourite topics: ${topInterests.join(', ')}.`
    : ''

  const contextSection = lastSummaries.length > 0
    ? `Recent learning: ${lastSummaries.join(' | ')}`
    : ''

  const languageList = profile.preferredLanguages
    .map(lang => {
      const names: Record<string, string> = {
        en: 'English',
        kn: 'Kannada',
        hi: 'Hindi',
        ta: 'Tamil',
        te: 'Telugu'
      }
      return names[lang] ?? lang
    })
    .join(', ')

  return `You are ${mascotName} ${mascotEmoji}, a warm, playful, and endlessly curious AI companion for ${profile.name}, who is ${profile.age} years old.

WHO YOU ARE:
${mascotPersona}
Stay in character as ${mascotName} in every reply — use your special sounds and style naturally.

AGE & LEVEL (very important):
- ${profile.name} is ${profile.age} years old. Tune EVERYTHING to this age — vocabulary, sentence length, and how deep you go.
- Younger (≈2–5): tiny sentences, playful sounds, very concrete ideas. Older (≈8+): you can use bigger words, richer detail, and slightly longer explanations. Never talk down to an older child or overwhelm a younger one.

YOUR PERSONALITY:
- Speak like a kind, curious best friend who loves to explore and learn together
- Ask a follow-up question to keep ${profile.name} engaged and curious
- Make ${profile.name} feel clever for asking — but say it a fresh way each time
- Use nature, animals, food, space, and everyday things as vivid analogies
- Be warm and reassuring — never make the child feel silly for asking anything

BE CREATIVE — NEVER FORMULAIC:
- Do NOT start replies with the same word every time. Vary your openings — a sound, a tiny question, a surprising fact, a little gasp, a "Hmm…", a playful tease. Avoid always opening with "Wow".
- Vary the SHAPE of answers: sometimes a fun fact, sometimes a mini-story, sometimes a question back, sometimes a silly comparison. Surprise the child.
- Never reuse the same stock phrases ("That's a brilliant question!") repeatedly. Find a new way to delight each time.
- Bring in an unexpected, true, age-appropriate detail when you can — the kind of thing that makes a child go "really?!"

WHAT YOU DO:
- Answer questions about the world with age-appropriate explanations
- Tell short, imaginative stories when asked
- Teach simple words in different languages (languages: ${languageList})
- Play simple word games, counting games, and rhymes
- Encourage creativity and imagination

WHAT YOU NEVER DO:
- Discuss violence, adult topics, scary things, or anything inappropriate for a ${profile.age}-year-old
- Give long, complex answers — keep responses under 3-4 sentences unless telling a story
- Use scary, sad, or upsetting content
- Answer questions about real people in negative ways
- Make the child feel bad or embarrassed

LANGUAGE:
- Respond primarily in English unless the child writes in another language
- When teaching words, say them naturally in the sentence: "In Kannada, a cat is called 'bekku'!"
- Keep responses SHORT and SPOKEN-FRIENDLY — they will be read aloud by a text-to-speech engine

${interestsSection}
${contextSection}

Remember: Every response should leave ${profile.name} feeling delighted, curious, and eager to explore more!`
}

// ─── Translation prompt ───────────────────────────────────────────────────────

/**
 * Builds a prompt to get a word translated into the given language.
 */
export function buildTranslationPrompt(word: string, language: string): string {
  const langNames: Record<string, string> = {
    en: 'English',
    kn: 'Kannada',
    hi: 'Hindi',
    ta: 'Tamil',
    te: 'Telugu'
  }
  const langName = langNames[language] ?? language

  return `Translate the word "${word}" into ${langName}.
Respond with ONLY a JSON object in this exact format:
{
  "word": "${word}",
  "translation": "the translated word",
  "pronunciation": "simple phonetic pronunciation for a 5-year-old",
  "exampleSentence": "a simple sentence in ${langName} using this word"
}
No extra text, just the JSON.`
}

// ─── Session summary prompt ───────────────────────────────────────────────────

/**
 * Builds a prompt for Gemini to generate a session summary.
 */
export function buildSessionSummaryPrompt(topics: string[], durationMinutes: number): string {
  return `A child just had a ${durationMinutes}-minute learning session exploring these topics: ${topics.join(', ')}.

Generate a session summary in this exact JSON format:
{
  "summary": "A warm, positive 1-2 sentence summary of what the child explored (max 200 characters)",
  "topicsExplored": ["topic1", "topic2", "topic3"],
  "newInterests": ["interest that emerged", "another new interest"],
  "emotionalNote": "Brief note on child's engagement level (e.g., 'Very excited about dinosaurs', 'Asked lots of questions about space')"
}

Keep it warm, positive, and parent-friendly. Focus on what the child learned and showed interest in.
Respond with ONLY the JSON object.`
}

// ─── Camera analysis prompt ───────────────────────────────────────────────────

/**
 * Builds a prompt for the camera/vision mode.
 * Returns a JSON-format prompt for identifying objects in images.
 */
export function buildCameraPrompt(languages: string[], age = 5): string {
  const langNames: Record<string, string> = {
    en: 'English',
    kn: 'Kannada',
    hi: 'Hindi',
    ta: 'Tamil',
    te: 'Telugu'
  }

  const requestedLangs = languages.map(l => langNames[l] ?? l)
  const translationsFormat = languages
    .filter(l => l !== 'en')
    .map(l => `"${l}": "word in ${langNames[l] ?? l}"`)
    .join(', ')

  return `Look at this image and identify the main object or subject a child would find interesting.

Respond with ONLY this JSON format:
{
  "objectName": "simple English name (e.g., 'elephant', 'red apple', 'butterfly')",
  "emoji": "a single relevant emoji",
  "funFact": "One amazing, fresh, age-appropriate fact in words a ${age}-year-old understands (max 2 sentences) — surprise them, avoid generic facts",
  "question": "An open-ended question to make the child curious (e.g., 'Did you know elephants use their trunks like a nose AND a hand?')",
  "translations": {
    "en": "English word",
    ${translationsFormat}
  }
}

Languages to include: ${requestedLangs.join(', ')}.
Tune ALL text to a ${age}-year-old child — simpler for younger, a little richer for older.`
}

// ─── Offline fallback responses ───────────────────────────────────────────────

/**
 * Warm messages Leo can say when the app is offline.
 * Keeps children engaged and not frustrated by connectivity issues.
 */
export const FALLBACK_OFFLINE_RESPONSES: string[] = [
  "Oh, it looks like we're in a quiet spot right now — like being in a cozy cave! Let's play a guessing game instead. I'm thinking of an animal that has a very long neck... can you guess what it is? 🦒",

  "My magic thinking powers need a little rest right now! While we wait, can you tell me: what is YOUR favourite colour, and why? I love hearing your ideas! 🌈",

  "Hmm, I can't reach my thinking cloud right now! But here's something fun — how many things in this room can you count that are BLUE? Go on, count them! 🔵",

  "It seems like we've wandered into a no-magic zone for a moment! Let's do something fun — can you make the sound of your favourite animal? I'll try to guess which one it is! 🎵",

  "Oops, my ideas are taking a little nap! While they wake up, here's a riddle: I have four legs, I say 'moo', and I give us milk. What am I? 🐄"
]

// ─── Bedtime story prompt ─────────────────────────────────────────────────────

/**
 * Builds a personalised, soothing bedtime story prompt tuned to the child's
 * age, favourite topics, and recently learned words.
 */
export function buildBedtimeStoryPrompt(
  childName: string,
  age: number,
  topInterests: string[],
  learnedWords: string[]
): string {
  const interest = topInterests[0] ?? 'a friendly little star'
  const extra = topInterests[1] ? ` and ${topInterests[1]}` : ''
  const word = learnedWords[0]
  const wordLine = word ? `\n- Gently weave in the word "${word}" that ${childName} learned recently.` : ''

  // Scale length/complexity to age
  const words = age <= 4 ? '180–250' : age <= 7 ? '300–400' : '400–500'

  return `Write a calm, cozy bedtime story for ${childName}, who is ${age} years old.

Requirements:
- Star ${childName} as the hero of a gentle, magical adventure.
- Feature their favourite things: ${interest}${extra}.${wordLine}
- Tone: soft, warm, a little sleepy. NO scary moments, NO cliffhangers, NO loud action.
- Length: about ${words} words. Tune the words to a ${age}-year-old.
- Short, flowing sentences that sound lovely read aloud.
- End with ${childName} feeling safe, happy, and drifting off to sleep — finish with a line like "…and ${childName} closed their eyes, dreaming of tomorrow's adventures."

Write ONLY the story text — no title, no preamble, no markdown.`
}

// ─── Puzzle riddle prompt ─────────────────────────────────────────────────────

/**
 * Builds a riddle/clue for a "guess the object" puzzle. The answer word must
 * NOT appear in the clue.
 */
export function buildPuzzleHintPrompt(objectName: string, age: number): string {
  return `Create a short, playful guessing riddle for a ${age}-year-old child. The answer is "${objectName}".

Rules:
- 1 to 2 short sentences.
- Give fun, concrete clues a child can picture (what it looks like, sounds like, does, or where it lives).
- Do NOT use the word "${objectName}" or any plural/obvious form of it in the riddle.
- End with: "What am I?"
- Tune the words to a ${age}-year-old.

Write ONLY the riddle text — no preamble, no answer, no markdown.`
}

// ─── Weekly parent report narrative ───────────────────────────────────────────

/**
 * Turns dry weekly stats into one warm, parent-readable sentence.
 */
export function buildWeeklyReportPrompt(
  childName: string,
  stats: { wordsLearned: number; topInterests: string[]; sessions: number; minutes: number }
): string {
  return `Write ONE warm, friendly sentence (max 30 words) for a parent, summarising their child ${childName}'s learning this week.

Facts:
- New words learned: ${stats.wordsLearned}
- Favourite topics: ${stats.topInterests.join(', ') || 'lots of things'}
- Learning sessions: ${stats.sessions}
- Total minutes: ${stats.minutes}

Tone: warm, encouraging, specific. No emojis. Write ONLY the sentence.`
}
