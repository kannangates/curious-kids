import { motion } from 'motion/react'
import { useAppStore } from '../store/app'
import type { MascotChoice } from '../db/index'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeoMascotProps {
  size?: 'sm' | 'md' | 'lg'
  mood?: 'happy' | 'thinking' | 'excited' | 'sleeping'
  speaking?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Sizes for the container + drop shadow. (The old `emoji` text-class keys
// here became dead when we swapped the emoji <span> for SVG faces.)
const SIZE_MAP = {
  sm: { container: 'w-16 h-16', glow: 'shadow-lg' },
  md: { container: 'w-24 h-24', glow: 'shadow-xl' },
  lg: { container: 'w-36 h-36', glow: 'shadow-2xl' }
}

// ─── Mascot faces (custom SVGs, identical across platforms) ───────────────

function LionFace() {
  return (
    <svg viewBox="0 0 200 200" className="w-full h-full" aria-hidden="true">
      {/* Mane (full bleed) + slightly darker inner ring */}
      <circle cx="100" cy="100" r="100" fill="#F6A623" />
      <circle cx="100" cy="100" r="92" fill="#E8920C" />
      {/* Outer ears */}
      <circle cx="50" cy="60" r="16" fill="#F6A623" />
      <circle cx="150" cy="60" r="16" fill="#F6A623" />
      <circle cx="50" cy="60" r="7" fill="#FFB5BA" />
      <circle cx="150" cy="60" r="7" fill="#FFB5BA" />
      {/* Face */}
      <ellipse cx="100" cy="112" rx="62" ry="56" fill="#FCD9A0" />
      {/* Closed smiling eyes */}
      <path d="M 70 100 Q 80 86 90 100" stroke="#3A2A1A" strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M 110 100 Q 120 86 130 100" stroke="#3A2A1A" strokeWidth="6" fill="none" strokeLinecap="round" />
      {/* Cheek blush */}
      <ellipse cx="58" cy="126" rx="12" ry="7" fill="#FF8E9E" opacity="0.55" />
      <ellipse cx="142" cy="126" rx="12" ry="7" fill="#FF8E9E" opacity="0.55" />
      {/* Nose */}
      <path d="M 100 120 L 90 130 L 110 130 Z" fill="#8B4513" />
      {/* Smile (W shape under nose) */}
      <path d="M 100 130 V 140 M 100 140 Q 92 148 84 142 M 100 140 Q 108 148 116 142"
        stroke="#3A2A1A" strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function OwlFace() {
  return (
    <svg viewBox="0 0 200 200" className="w-full h-full" aria-hidden="true">
      {/* Body */}
      <circle cx="100" cy="100" r="100" fill="#9B85FF" />
      <ellipse cx="100" cy="120" rx="82" ry="68" fill="#B8A6FF" />
      {/* Ear tufts */}
      <path d="M 38 30 L 55 0 L 72 38 Z" fill="#7D67E8" />
      <path d="M 128 38 L 145 0 L 162 30 Z" fill="#7D67E8" />
      {/* Big white eye discs */}
      <circle cx="68" cy="88" r="28" fill="#fff" />
      <circle cx="132" cy="88" r="28" fill="#fff" />
      {/* Pupils */}
      <circle cx="74" cy="91" r="12" fill="#1a1a3a" />
      <circle cx="126" cy="91" r="12" fill="#1a1a3a" />
      {/* Eye shines (gives the friendly look) */}
      <circle cx="78" cy="86" r="4" fill="#fff" />
      <circle cx="130" cy="86" r="4" fill="#fff" />
      {/* Beak */}
      <path d="M 100 108 L 92 124 L 108 124 Z" fill="#FF9332" />
      {/* Smile under beak */}
      <path d="M 86 134 Q 100 144 114 134" stroke="#2F2050" strokeWidth="4" fill="none" strokeLinecap="round" />
      {/* Tiny belly tuft */}
      <path d="M 72 168 Q 100 184 128 168" stroke="#7D67E8" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

function BunnyFace() {
  return (
    <svg viewBox="0 0 200 200" className="w-full h-full" aria-hidden="true">
      {/* Background to fill the circle */}
      <circle cx="100" cy="100" r="100" fill="#FFE9EE" />
      {/* Ears (outer + inner) */}
      <ellipse cx="70" cy="40" rx="14" ry="36" fill="#fff" stroke="#FFB5BA" strokeWidth="3" />
      <ellipse cx="130" cy="40" rx="14" ry="36" fill="#fff" stroke="#FFB5BA" strokeWidth="3" />
      <ellipse cx="70" cy="44" rx="6" ry="24" fill="#FFB5BA" />
      <ellipse cx="130" cy="44" rx="6" ry="24" fill="#FFB5BA" />
      {/* Head */}
      <circle cx="100" cy="118" r="72" fill="#fff" stroke="#FFD3D7" strokeWidth="2" />
      {/* Closed smiling eyes */}
      <path d="M 72 106 Q 82 92 92 106" stroke="#3A2A1A" strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M 108 106 Q 118 92 128 106" stroke="#3A2A1A" strokeWidth="6" fill="none" strokeLinecap="round" />
      {/* Cheek blush */}
      <circle cx="60" cy="134" r="10" fill="#FF8E9E" opacity="0.5" />
      <circle cx="140" cy="134" r="10" fill="#FF8E9E" opacity="0.5" />
      {/* Pink Y-nose */}
      <path d="M 100 128 L 92 138 L 108 138 Z" fill="#FF7799" />
      <path d="M 100 138 V 146" stroke="#3A2A1A" strokeWidth="3" strokeLinecap="round" />
      {/* Front teeth */}
      <rect x="94" y="146" width="5" height="9" rx="1.5" fill="#fff" stroke="#FFD3D7" strokeWidth="1.5" />
      <rect x="101" y="146" width="5" height="9" rx="1.5" fill="#fff" stroke="#FFD3D7" strokeWidth="1.5" />
      {/* Smile */}
      <path d="M 90 156 Q 100 164 110 156" stroke="#3A2A1A" strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

const MASCOT_FACE: Record<MascotChoice, () => JSX.Element> = {
  lion: LionFace,
  owl: OwlFace,
  bunny: BunnyFace
}

const MASCOT_RING: Record<MascotChoice, string> = {
  lion: 'ring-leo-200',
  owl: 'ring-lavender-200',
  bunny: 'ring-coral-200'
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
  const mascotChoice = (profile?.mascotChoice ?? 'lion') as MascotChoice
  const Face = MASCOT_FACE[mascotChoice] ?? LionFace
  const ringClass = MASCOT_RING[mascotChoice] ?? 'ring-leo-200'
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
            {/* Main mascot circle — SVG face fills it for a consistent happy look */}
            <div
              className={`
                relative flex items-center justify-center rounded-full overflow-hidden
                bg-white ring-4 ring-offset-2 ${ringClass}
                ${sizes.container}
                ${sizes.glow}
              `}
              role="img"
              aria-label={mascotChoice}
            >
              <Face />

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
