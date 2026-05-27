import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { db } from '../db/index'
import type { InterestTag, SessionSummary } from '../db/index'
import { useAppStore } from '../store/app'
import { decayInterests, buildGreeting, getTopInterests } from '../lib/memory'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

// ─── Navigation card ──────────────────────────────────────────────────────────

interface NavCardProps {
  emoji: string
  label: string
  sublabel: string
  gradient: string
  onClick: () => void
  delay?: number
}

function NavCard({ emoji, label, sublabel, gradient, onClick, delay = 0 }: NavCardProps) {
  return (
    <motion.button
      onClick={onClick}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: 'easeOut' }}
      whileTap={{ scale: 0.95 }}
      className={`
        flex flex-col items-center justify-center gap-1
        rounded-3xl p-4 shadow-md
        ${gradient}
        active:shadow-sm transition-shadow
        min-h-[100px]
      `}
    >
      <span className="text-4xl leading-none">{emoji}</span>
      <p className="font-extrabold text-white text-base leading-tight">{label}</p>
      <p className="font-semibold text-white/80 text-xs">{sublabel}</p>
    </motion.button>
  )
}

// ─── HomeScreen ───────────────────────────────────────────────────────────────

export function HomeScreen() {
  const navigate = useNavigate()
  const { profile, setProfile } = useAppStore()

  const [lastSummary, setLastSummary] = useState<SessionSummary | null>(null)
  const [topInterests, setTopInterests] = useState<InterestTag[]>([])
  const [greeting, setGreeting] = useState('')
  const [speechBubble, setSpeechBubble] = useState("What shall we explore today? 🌟")

  // ── Topic chip emoji helper ────────────────────────────────────────────────

  const TOPIC_EMOJIS: Record<string, string> = {
    lion: '🦁', tiger: '🐯', elephant: '🐘', dinosaur: '🦕', space: '🚀',
    star: '⭐', bird: '🐦', fish: '🐠', ocean: '🌊', tree: '🌳',
    flower: '🌸', sun: '☀️', moon: '🌙', rain: '🌧️', rainbow: '🌈',
    robot: '🤖', train: '🚂', plane: '✈️', car: '🚗', boat: '⛵',
    butterfly: '🦋', bee: '🐝', frog: '🐸', panda: '🐼', penguin: '🐧',
    horse: '🐴', shark: '🦈', whale: '🐳', turtle: '🐢', dog: '🐶',
    cat: '🐱', rabbit: '🐰', snake: '🐍', monkey: '🐒', giraffe: '🦒',
    zebra: '🦓', kangaroo: '🦘', koala: '🐨', dragon: '🐉', unicorn: '🦄',
    math: '🔢', music: '🎵', art: '🎨', science: '🔬', nature: '🌿',
    water: '💧', fire: '🔥', earth: '🌍', wind: '🌬️', cloud: '☁️'
  }

  function chipEmoji(tag: string): string {
    return TOPIC_EMOJIS[tag.toLowerCase()] ?? '✨'
  }

  useEffect(() => {
    let cancelled = false

    async function loadHomeData() {
      if (!profile) return

      try {
        // Apply daily interest decay first
        await decayInterests(profile.id)

        // Update lastActiveAt
        const now = new Date().toISOString()
        await db.childProfiles.update(profile.id, { lastActiveAt: now })
        if (!cancelled) setProfile({ ...profile, lastActiveAt: now })

        // Get last session summary
        const summaries = await db.sessionSummaries
          .where('profileId').equals(profile.id)
          .toArray()
        const sorted = summaries.sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        )
        const latest = sorted[0] ?? null
        if (!cancelled) setLastSummary(latest)

        // Build personalised greeting via memory module
        const greetingText = await buildGreeting(profile)
        if (!cancelled) setGreeting(greetingText)

        // Get top 3 interests for the topic strip
        const top3 = await getTopInterests(profile.id, 3)
        if (!cancelled) setTopInterests(top3)

        // Set speech bubble from latest summary or default
        if (latest?.summary) {
          if (!cancelled) setSpeechBubble(latest.summary)
        } else if (top3.length > 0) {
          if (!cancelled) setSpeechBubble(`Let's learn more about ${top3[0].tag} today! 🌟`)
        }
      } catch (err) {
        console.error('Failed to load home data:', err)
      }
    }

    void loadHomeData()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  const mascotName =
    profile?.mascotChoice === 'lion'
      ? 'Leo'
      : profile?.mascotChoice === 'owl'
      ? 'Ollie'
      : 'Benny'

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-200 via-coral-100 to-mint-100 overflow-y-auto">
      <div className="flex flex-col flex-1 px-4 py-2 max-w-sm mx-auto w-full">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-4">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 min-w-0"
          >
            <p className="text-base font-bold text-lavender-700 truncate">{greeting}</p>
          </motion.div>

          {/* Settings cog */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate('/settings')}
            className="
              w-10 h-10 flex items-center justify-center
              bg-white/60 rounded-full text-xl
              backdrop-blur-sm shadow-sm
              ml-2 flex-shrink-0
            "
            aria-label="Parent settings"
          >
            ⚙️
          </motion.button>
        </div>

        {/* Mascot + speech bubble */}
        <div className="flex flex-col items-center mb-6">
          {/* Speech bubble */}
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.3 }}
            className="
              relative bg-white rounded-3xl px-5 py-3 shadow-md
              mb-3 max-w-[260px] text-center
              before:content-[''] before:absolute before:bottom-[-10px] before:left-1/2
              before:-translate-x-1/2 before:border-[10px] before:border-transparent
              before:border-t-white
            "
          >
            <p className="text-sm font-bold text-lavender-700 leading-relaxed">
              {speechBubble}
            </p>
          </motion.div>

          {/* Mascot */}
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
          >
            <LeoMascot size="lg" mood="happy" />
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-2 text-lg font-extrabold text-lavender-600"
          >
            {mascotName}
          </motion.p>
        </div>

        {/* Navigation grid */}
        <div className="grid grid-cols-2 gap-3">
          <NavCard
            emoji="🎙️"
            label="Talk to Leo"
            sublabel="Ask anything!"
            gradient="bg-gradient-to-br from-lavender-500 to-lavender-700"
            onClick={() => navigate('/chat')}
            delay={0.1}
          />
          <NavCard
            emoji="📷"
            label="What Is This?"
            sublabel="Point & learn!"
            gradient="bg-gradient-to-br from-sky-400 to-sky-600"
            onClick={() => navigate('/camera')}
            delay={0.2}
          />
          <NavCard
            emoji="📚"
            label="Word Explorer"
            sublabel="Learn new words!"
            gradient="bg-gradient-to-br from-coral-400 to-coral-600"
            onClick={() => navigate('/words')}
            delay={0.3}
          />
          <NavCard
            emoji="✨"
            label="My Discoveries"
            sublabel="All I've learned!"
            gradient="bg-gradient-to-br from-mint-500 to-mint-700"
            onClick={() => navigate('/discoveries')}
            delay={0.4}
          />
          <NavCard
            emoji="🎮"
            label="Word Match"
            sublabel="Play & guess!"
            gradient="bg-gradient-to-br from-leo-400 to-leo-600"
            onClick={() => navigate('/wordgame')}
            delay={0.5}
          />
          <NavCard
            emoji="🧩"
            label="Puzzle Time"
            sublabel="Solve riddles!"
            gradient="bg-gradient-to-br from-lavender-400 to-sky-500"
            onClick={() => navigate('/puzzle')}
            delay={0.6}
          />
          <NavCard
            emoji="🌙"
            label="Bedtime Story"
            sublabel="A tale for you!"
            gradient="bg-gradient-to-br from-indigo-400 to-violet-600"
            onClick={() => navigate('/bedtime')}
            delay={0.7}
          />
        </div>

        {/* Today's topic strip */}
        {topInterests.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55 }}
            className="mt-3"
          >
            <p className="text-xs font-bold text-lavender-500 text-center mb-2">
              Today's topics
            </p>
            <div className="flex gap-2 justify-center flex-wrap">
              {topInterests.map((tag, idx) => (
                <motion.button
                  key={tag.id ?? tag.tag}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.6 + idx * 0.05 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => navigate(`/chat?q=${encodeURIComponent(`Tell me about ${tag.tag}`)}`)}
                  className="
                    flex items-center gap-1.5 px-3 py-1.5
                    bg-white/80 backdrop-blur-sm rounded-full shadow-sm
                    border border-lavender-100
                    active:shadow-md transition-shadow
                    min-h-[36px]
                  "
                >
                  <span className="text-base leading-none">{chipEmoji(tag.tag)}</span>
                  <span className="text-xs font-bold text-lavender-700 capitalize">
                    {tag.tag}
                  </span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Bottom info strip */}
        {lastSummary && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
            className="mt-3 px-4 py-2 bg-white/50 rounded-2xl backdrop-blur-sm"
          >
            <p className="text-xs text-center text-lavender-600 font-semibold truncate">
              Last time: {lastSummary.topicsExplored.slice(0, 3).join(', ')} 🌈
            </p>
          </motion.div>
        )}
      </div>
    </SafeArea>
  )
}
