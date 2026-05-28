import { motion } from 'motion/react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface VoiceButtonProps {
  isListening: boolean
  onStart: () => void
  onStop: () => void
  disabled?: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VoiceButton({ isListening, onStart, onStop, disabled = false }: VoiceButtonProps) {
  const handlePress = (): void => {
    if (disabled) return
    if (isListening) {
      onStop()
    } else {
      onStart()
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Outer pulsing ring — only when listening */}
      <div className="relative flex items-center justify-center">
        {isListening && (
          <>
            {/* Animated ring 1 */}
            <motion.div
              className="absolute w-24 h-24 rounded-full border-4 border-red-400"
              animate={{ scale: [1, 1.4, 1], opacity: [0.7, 0, 0.7] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            />
            {/* Animated ring 2 */}
            <motion.div
              className="absolute w-24 h-24 rounded-full border-4 border-red-300"
              animate={{ scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
            />
          </>
        )}

        {/* Main button */}
        <motion.button
          onClick={handlePress}
          disabled={disabled}
          whileTap={{ scale: disabled ? 1 : 0.92 }}
          whileHover={{ scale: disabled ? 1 : 1.05 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          className={`
            relative flex items-center justify-center
            w-20 h-20 rounded-full
            focus:outline-none focus:ring-4 focus:ring-offset-2
            transition-all duration-200
            disabled:opacity-50 disabled:cursor-not-allowed
            ${isListening
              ? 'bg-gradient-to-br from-red-400 to-red-600 shadow-lg shadow-red-300 focus:ring-red-300'
              : 'bg-gradient-to-br from-lavender-500 to-lavender-700 shadow-lg shadow-lavender-300 focus:ring-lavender-300'
            }
          `}
          aria-label={isListening ? 'Stop listening' : 'Start speaking'}
          aria-pressed={isListening}
        >
          {/* Icon */}
          <span className="text-3xl leading-none select-none" aria-hidden>
            {isListening ? '🔴' : '🎙️'}
          </span>

          {/* Listening indicator bar */}
          {isListening && (
            <motion.div
              className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5 items-end"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {[0, 1, 2, 3].map(i => (
                <motion.div
                  key={i}
                  className="w-1 rounded-full bg-white/80"
                  animate={{ height: ['6px', '16px', '6px'] }}
                  transition={{
                    duration: 0.5,
                    repeat: Infinity,
                    delay: i * 0.1,
                    ease: 'easeInOut'
                  }}
                />
              ))}
            </motion.div>
          )}
        </motion.button>
      </div>

      {/* Label */}
      <motion.p
        key={isListening ? 'listening' : 'idle'}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={`
          text-sm font-bold tracking-wide
          ${isListening ? 'text-red-500' : 'text-lavender-600'}
          ${disabled ? 'opacity-50' : ''}
        `}
      >
        {isListening ? 'Listening...' : 'Tap to speak'}
      </motion.p>
    </div>
  )
}
