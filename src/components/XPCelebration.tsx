import { useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { playCelebration } from '../lib/audio'

// ─── Types ────────────────────────────────────────────────────────────────────

interface XPCelebrationProps {
  /** Whether the overlay is visible */
  visible: boolean
  /** XP gained this event */
  gained: number
  /** Set to a non-empty string if the user just levelled up */
  levelUpLabel?: string
  /** Called when the overlay should be dismissed (after 2 s auto-dismiss) */
  onDismiss: () => void
}

// ─── Star burst particles ──────────────────────────────────────────────────

const STARS = ['⭐', '🌟', '✨', '💫', '⭐', '🌟', '✨']

// ─── XPCelebration ────────────────────────────────────────────────────────────

export function XPCelebration({
  visible,
  gained,
  levelUpLabel,
  onDismiss
}: XPCelebrationProps) {
  // Play celebration chime + auto-dismiss after 2 seconds
  useEffect(() => {
    if (!visible) return
    playCelebration()
    const timer = setTimeout(() => {
      onDismiss()
    }, 2000)
    return () => clearTimeout(timer)
  }, [visible, onDismiss])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="xp-celebration"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none"
          aria-live="polite"
          aria-label={`You earned ${gained} XP`}
        >
          {/* Backdrop blur tint */}
          <div className="absolute inset-0 bg-black/20" />

          {/* Star burst particles */}
          {STARS.map((star, i) => {
            const angle = (i / STARS.length) * 360
            const distance = 90 + Math.random() * 40
            const rad = (angle * Math.PI) / 180
            const tx = Math.cos(rad) * distance
            const ty = Math.sin(rad) * distance

            return (
              <motion.span
                key={i}
                className="absolute text-2xl select-none"
                initial={{ opacity: 1, x: 0, y: 0, scale: 0.5 }}
                animate={{
                  opacity: [1, 1, 0],
                  x: tx,
                  y: ty,
                  scale: [0.5, 1.3, 0.8],
                  rotate: [0, 360]
                }}
                transition={{
                  duration: 1.5,
                  ease: 'easeOut',
                  delay: i * 0.05
                }}
              >
                {star}
              </motion.span>
            )
          })}

          {/* Center card */}
          <motion.div
            initial={{ scale: 0.4, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.7, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            className="relative z-10 flex flex-col items-center gap-2 px-10 py-8 rounded-3xl bg-white shadow-2xl border-4 border-leo-300"
          >
            {/* Main star emoji */}
            <motion.span
              className="text-7xl leading-none"
              animate={{ rotate: [0, -10, 10, -10, 0], scale: [1, 1.2, 1] }}
              transition={{ duration: 0.6, delay: 0.1 }}
            >
              {gained >= 15 ? '🏆' : gained >= 10 ? '🌟' : '⭐'}
            </motion.span>

            {/* XP gained text */}
            <motion.p
              className="text-4xl font-extrabold text-leo-600 tracking-tight"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.15 }}
            >
              +{gained} XP
            </motion.p>

            {/* Level up badge */}
            {levelUpLabel && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 350, damping: 20, delay: 0.3 }}
                className="mt-1 px-4 py-1.5 bg-gradient-to-r from-leo-400 to-coral-400 rounded-full"
              >
                <p className="text-sm font-extrabold text-white whitespace-nowrap">
                  LEVEL UP! {levelUpLabel}
                </p>
              </motion.div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
