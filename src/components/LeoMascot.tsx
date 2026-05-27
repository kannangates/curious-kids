import { motion } from 'framer-motion'
import { useAppStore } from '../store/app'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeoMascotProps {
  size?: 'sm' | 'md' | 'lg'
  mood?: 'happy' | 'thinking' | 'excited' | 'sleeping'
  speaking?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SIZE_MAP = {
  sm: {
    container: 'w-16 h-16',
    emoji: 'text-4xl',
    glow: 'shadow-lg'
  },
  md: {
    container: 'w-24 h-24',
    emoji: 'text-5xl',
    glow: 'shadow-xl'
  },
  lg: {
    container: 'w-36 h-36',
    emoji: 'text-7xl',
    glow: 'shadow-2xl'
  }
}

const MASCOT_EMOJI: Record<string, string> = {
  lion: '🦁',
  owl: '🦉',
  bunny: '🐰'
}

const MOOD_OVERLAY: Record<string, string | null> = {
  happy: null,
  thinking: '💭',
  excited: null,
  sleeping: '💤'
}

// ─── Animation variants ───────────────────────────────────────────────────────

const bobVariants = {
  animate: {
    y: [0, -10, 0],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut' as const
    }
  }
}

const speakingVariants = {
  // Organic "talking" motion: gentle bob + wiggle + scale, so Leo feels alive
  // while speaking rather than just pulsing.
  animate: {
    scale: [1, 1.06, 0.98, 1.05, 1],
    rotate: [0, -3, 3, -2, 0],
    y: [0, -4, 0, -3, 0],
    transition: {
      duration: 0.7,
      repeat: Infinity,
      ease: 'easeInOut' as const
    }
  },
  idle: {
    scale: 1,
    rotate: 0,
    y: 0,
    transition: { duration: 0.2 }
  }
}

const excitedVariants = {
  animate: {
    rotate: [-5, 5, -5, 5, 0],
    transition: {
      duration: 0.5,
      repeat: 2,
      ease: 'easeInOut' as const
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LeoMascot({ size = 'md', mood = 'happy', speaking = false }: LeoMascotProps) {
  const profile = useAppStore(s => s.profile)
  const mascotChoice = profile?.mascotChoice ?? 'lion'
  const emoji = MASCOT_EMOJI[mascotChoice]
  const moodOverlay = MOOD_OVERLAY[mood]
  const sizes = SIZE_MAP[size]

  return (
    <div className="relative inline-flex items-center justify-center select-none">
      {/* Outer radial glow ring */}
      <div
        className={`
          absolute inset-0 rounded-full
          ${speaking ? 'animate-pulse-gentle' : ''}
        `}
        style={{
          transform: 'scale(1.4)',
          background: 'radial-gradient(circle, rgba(252,211,77,0.35) 0%, rgba(253,230,138,0.15) 50%, transparent 70%)'
        }}
      />

      {/* Bob animation wrapper */}
      <motion.div
        variants={bobVariants}
        animate={speaking ? undefined : 'animate'}
      >
        {/* Speaking pulse wrapper */}
        <motion.div
          variants={speakingVariants}
          animate={speaking ? 'animate' : 'idle'}
        >
          {/* Excited shake wrapper */}
          <motion.div
            variants={mood === 'excited' ? excitedVariants : {}}
            animate={mood === 'excited' ? 'animate' : undefined}
          >
            {/* Main mascot circle */}
            <div
              className={`
                relative flex items-center justify-center rounded-full
                bg-gradient-to-br from-leo-300 via-leo-400 to-leo-500
                ring-4 ring-leo-200 ring-offset-2
                ${sizes.container}
                ${sizes.glow}
              `}
            >
              {/* Mascot emoji */}
              <span className={`${sizes.emoji} leading-none`} role="img" aria-label={mascotChoice}>
                {emoji}
              </span>

              {/* Mood overlay bubble */}
              {moodOverlay && (
                <motion.span
                  className="absolute -top-2 -right-2 text-2xl"
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                >
                  {moodOverlay}
                </motion.span>
              )}

              {/* Speaking indicator dots */}
              {speaking && (
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5">
                  {[0, 1, 2].map(i => (
                    <motion.div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-leo-600"
                      animate={{
                        scaleY: [1, 2, 1],
                        opacity: [0.6, 1, 0.6]
                      }}
                      transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: 'easeInOut'
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  )
}
