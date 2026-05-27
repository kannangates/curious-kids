import { useState } from 'react'
import { motion } from 'framer-motion'
import { LeoMascot } from './LeoMascot'
import { SafeArea } from './SafeArea'

interface TimeUpScreenProps {
  childName: string
  limitMinutes: number
  /** Parent action: grant a few more minutes and resume */
  onGrantBonus: (minutes: number) => void
}

/**
 * Gentle, child-friendly "screen time is over" screen.
 * Blocks the app until tomorrow, unless a parent grants bonus minutes.
 */
export function TimeUpScreen({ childName, limitMinutes, onGrantBonus }: TimeUpScreenProps) {
  const [showParent, setShowParent] = useState(false)

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-200 via-coral-100 to-leo-100">
      <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 16 }}
        >
          <LeoMascot size="lg" mood="sleeping" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h1 className="text-3xl font-extrabold text-lavender-700 mb-2">
            Great exploring, {childName}! 🌙
          </h1>
          <p className="text-lg text-lavender-600 font-semibold max-w-[300px]">
            Playtime is over for now. Leo needs a little nap — let's discover more tomorrow! 💤
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="bg-white/70 backdrop-blur-sm rounded-2xl px-5 py-3 shadow-sm"
        >
          <p className="text-sm font-bold text-lavender-500">
            Today's playtime: {limitMinutes} minutes ⏰
          </p>
        </motion.div>

        {/* Parent override */}
        {!showParent ? (
          <button
            onClick={() => setShowParent(true)}
            className="text-sm text-lavender-400 font-semibold underline underline-offset-4 mt-2"
          >
            I'm a parent
          </button>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center gap-3 mt-2"
          >
            <p className="text-xs text-gray-500 font-medium max-w-[260px]">
              Grant a few more minutes? The timer resets fully tomorrow morning.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onGrantBonus(5)}
                className="px-5 py-2.5 bg-mint-500 text-white font-extrabold rounded-2xl shadow-md active:scale-95 text-sm"
              >
                +5 minutes
              </button>
              <button
                onClick={() => onGrantBonus(15)}
                className="px-5 py-2.5 bg-lavender-500 text-white font-extrabold rounded-2xl shadow-md active:scale-95 text-sm"
              >
                +15 minutes
              </button>
            </div>
            <button
              onClick={() => setShowParent(false)}
              className="text-xs text-gray-400 font-semibold mt-1"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </div>
    </SafeArea>
  )
}
