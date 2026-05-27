import { db, safeDbWrite } from '../db/index'
import type { InterestTag, ChildProfile } from '../db/index'

// ─── Stopwords ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'that', 'this', 'with', 'have', 'from', 'they', 'been', 'were', 'will',
  'your', 'what', 'when', 'where', 'which', 'there', 'their', 'about',
  'would', 'could', 'should', 'some', 'more', 'into', 'over', 'also',
  'than', 'then', 'them', 'these', 'those', 'here', 'just', 'like',
  'such', 'very', 'only', 'other', 'after', 'before', 'between',
  'does', 'each', 'most', 'both', 'many', 'through', 'during',
  'while', 'because', 'though', 'however', 'really', 'even',
  'hello', 'okay', 'sure', 'yes', 'yeah', 'hmm', 'well', 'tell',
  'know', 'want', 'think', 'said', 'called', 'named', 'make', 'made',
  'much', 'long', 'little', 'back', 'come', 'good', 'great',
  'look', 'think', 'also', 'time', 'year', 'live', 'give'
])

// ─── Common animal names for capitalised-noun detection ───────────────────────

const ANIMAL_NAMES = new Set([
  'lion', 'tiger', 'elephant', 'giraffe', 'zebra', 'penguin', 'dolphin',
  'whale', 'shark', 'eagle', 'parrot', 'monkey', 'gorilla', 'panda',
  'koala', 'kangaroo', 'crocodile', 'dinosaur', 'butterfly', 'caterpillar',
  'cheetah', 'leopard', 'jaguar', 'chimpanzee', 'flamingo', 'peacock',
  'toucan', 'octopus', 'jellyfish', 'starfish', 'seahorse', 'turtle',
  'rabbit', 'hamster', 'squirrel', 'hedgehog', 'raccoon', 'otter',
  'beaver', 'reindeer', 'moose', 'bison', 'camel', 'llama', 'alpaca',
  'meerkat', 'mongoose', 'chameleon', 'gecko', 'iguana', 'python',
  'cobra', 'scorpion', 'tarantula', 'firefly', 'ladybug', 'grasshopper'
])

// ─── Topic extraction ─────────────────────────────────────────────────────────

/**
 * Extract potential topic keywords from a text string.
 * Simple heuristic: words > 4 chars, not in stopword list,
 * capitalised nouns or known animal names.
 * Returns deduplicated lowercase array, max 5 items.
 */
export function extractTopics(text: string): string[] {
  if (!text || typeof text !== 'string') return []

  // Split into words, keep original capitalisation for noun detection
  const words = text.replace(/[^a-zA-Z\s]/g, ' ').split(/\s+/).filter(Boolean)

  const seen = new Set<string>()
  const topics: string[] = []

  for (const word of words) {
    if (topics.length >= 5) break

    const lower = word.toLowerCase()

    // Skip short words and stopwords
    if (lower.length <= 4 || STOPWORDS.has(lower)) continue

    // Accept if it's a known animal name
    if (ANIMAL_NAMES.has(lower)) {
      if (!seen.has(lower)) {
        seen.add(lower)
        topics.push(lower)
      }
      continue
    }

    // Accept capitalised words (likely proper nouns / topics) — but not ALL_CAPS
    const isCapitalisedNoun = word[0] === word[0].toUpperCase() &&
      word[0] !== word[0].toLowerCase() &&
      word !== word.toUpperCase()

    if (isCapitalisedNoun && !seen.has(lower)) {
      seen.add(lower)
      topics.push(lower)
      continue
    }

    // Accept longer content words (>6 chars) that aren't stopwords
    if (lower.length > 6 && !seen.has(lower)) {
      seen.add(lower)
      topics.push(lower)
    }
  }

  return topics
}

// ─── Interest decay ───────────────────────────────────────────────────────────

// Module-level sentinel: ensures decay runs at most once per calendar day
// per browser session, preventing repeated decay on multiple HomeScreen mounts.
let lastDecayProfileDate: Record<string, string> = {}

/**
 * Decay all interest weights for a profile.
 * Subtracts 0.1 per day since lastMentioned. Floor at 0.
 * Tags with weight <= 0 are deleted.
 * Runs at most once per calendar day per profile.
 */
export async function decayInterests(profileId: string): Promise<void> {
  const today = new Date().toDateString()
  if (lastDecayProfileDate[profileId] === today) return
  lastDecayProfileDate[profileId] = today

  try {
    const tags = await db.interestTags
      .where('profileId')
      .equals(profileId)
      .toArray()

    const now = Date.now()

    for (const tag of tags) {
      const daysSince = Math.floor(
        (now - new Date(tag.lastMentioned).getTime()) / (1000 * 60 * 60 * 24)
      )
      if (daysSince <= 0) continue

      const decay = daysSince * 0.1
      const newWeight = Math.max(0, tag.weight - decay)

      if (newWeight <= 0 && tag.id !== undefined) {
        await safeDbWrite(() => db.interestTags.delete(tag.id!))
      } else if (tag.id !== undefined) {
        // Update lastMentioned to today so repeated calls this session don't re-decay
        await safeDbWrite(() =>
          db.interestTags.update(tag.id!, {
            weight: newWeight,
            lastMentioned: new Date().toISOString()
          })
        )
      }
    }
  } catch (err) {
    console.error('[memory] decayInterests failed:', err)
  }
}

// ─── Interest bump ────────────────────────────────────────────────────────────

/**
 * Upsert a tag: if exists, add delta (cap at 10). If new, insert with weight = 1.
 */
export async function bumpInterest(
  profileId: string,
  tag: string,
  delta = 1
): Promise<void> {
  try {
    const normalised = tag.toLowerCase().trim()
    if (!normalised) return

    const existing = await db.interestTags
      .where('profileId')
      .equals(profileId)
      .filter(t => t.tag === normalised)
      .first()

    const now = new Date().toISOString()

    if (existing?.id !== undefined) {
      await safeDbWrite(() =>
        db.interestTags.update(existing.id!, {
          weight: Math.min(10, existing.weight + delta),
          lastMentioned: now
        })
      )
    } else {
      await safeDbWrite(() =>
        db.interestTags.add({
          profileId,
          tag: normalised,
          weight: Math.min(10, delta > 0 ? delta : 1),
          lastMentioned: now
        })
      )
    }
  } catch (err) {
    console.error('[memory] bumpInterest failed:', err)
  }
}

// ─── Top interests ────────────────────────────────────────────────────────────

/**
 * Return top N tags sorted by weight descending.
 */
export async function getTopInterests(
  profileId: string,
  n = 5
): Promise<InterestTag[]> {
  try {
    const tags = await db.interestTags
      .where('profileId')
      .equals(profileId)
      .toArray()
    return tags.sort((a, b) => b.weight - a.weight).slice(0, n)
  } catch (err) {
    console.error('[memory] getTopInterests failed:', err)
    return []
  }
}

// ─── Greeting builder ─────────────────────────────────────────────────────────

function getTimeOfDay(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

/**
 * Returns a personalised greeting string for HomeScreen.
 * Uses: lastActiveAt, top interests, last session summary.
 */
export async function buildGreeting(profile: ChildProfile): Promise<string> {
  try {
    const topTags = await getTopInterests(profile.id, 1)
    const topTag = topTags[0]

    const now = new Date()
    const lastActive = new Date(profile.lastActiveAt)
    const todayStr = now.toDateString()
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(now.getDate() - 1)
    const yesterdayStr = yesterdayDate.toDateString()
    const lastActiveStr = lastActive.toDateString()

    if (lastActiveStr === todayStr) {
      return `Welcome back ${profile.name}! 🌟`
    }

    if (lastActiveStr === yesterdayStr && topTag) {
      const tod = getTimeOfDay()
      return `Good ${tod} ${profile.name}! Yesterday you were learning about ${topTag.tag}! 🦁`
    }

    if (topTag) {
      return `Roarr! ${profile.name} is back! Ready to explore ${topTag.tag} again? 🎉`
    }

    const timeOfDay = getTimeOfDay()
    return `Roarr! Good ${timeOfDay}, ${profile.name}! What shall we discover today? 🌈`
  } catch (err) {
    console.error('[memory] buildGreeting failed:', err)
    return `Welcome back, ${profile.name}! 🌟`
  }
}
