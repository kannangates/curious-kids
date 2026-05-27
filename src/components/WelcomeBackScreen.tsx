import { useState } from 'react'
import { useGoogleLogin } from '@react-oauth/google'
import { motion } from 'framer-motion'
import type { ChildProfile } from '../db/index'
import { useAppStore } from '../store/app'
import { LeoMascot } from './LeoMascot'
import { SafeArea } from './SafeArea'

interface WelcomeBackScreenProps {
  profile: ChildProfile
}

/**
 * Shown when a profile exists but the in-memory Google `sub` is missing
 * (e.g. after a page refresh). The `sub` is never persisted — it's only used
 * to derive the key that decrypts the Gemini API key — so we recover it with a
 * single tap that re-runs the Google token flow. Local data (interests,
 * discoveries, XP) is already in IndexedDB; this only restores the session.
 */
export function WelcomeBackScreen({ profile }: WelcomeBackScreenProps) {
  const { setGoogleSub, setGoogleToken } = useAppStore()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mascotName =
    profile.mascotChoice === 'lion' ? 'Leo'
    : profile.mascotChoice === 'owl' ? 'Ollie'
    : 'Benny'

  const login = useGoogleLogin({
    scope: 'openid profile email https://www.googleapis.com/auth/drive.appdata',
    onSuccess: async (tokenResponse) => {
      setIsLoading(true)
      setError(null)
      try {
        const accessToken = tokenResponse.access_token
        const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.json()) as { sub?: string }
        if (!info.sub) throw new Error('Could not read your Google account')
        // Setting the sub flips the gate in RequireAuth and renders the app
        setGoogleToken(accessToken)
        setGoogleSub(info.sub)
      } catch (err) {
        setError(`Couldn't continue: ${err instanceof Error ? err.message : String(err)}`)
        setIsLoading(false)
      }
    },
    onError: () => setError('Sign-in was cancelled. Tap to try again.')
  })

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-100 via-coral-50 to-mint-100">
      <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
        >
          <LeoMascot size="lg" mood="excited" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <h1 className="text-3xl font-extrabold text-lavender-700 mb-1">
            Welcome back, {profile.name}! 🎉
          </h1>
          <p className="text-lg text-lavender-500 font-semibold max-w-[300px]">
            {mascotName} missed you! Tap to continue and let's keep exploring.
          </p>
        </motion.div>

        {isLoading ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="w-9 h-9 border-4 border-lavender-300 border-t-lavender-600 rounded-full animate-spin" />
            <p className="text-sm text-lavender-500 font-bold">Waking up {mascotName}...</p>
          </div>
        ) : (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => login()}
            className="
              w-full max-w-xs py-4 text-xl font-extrabold text-white
              bg-gradient-to-r from-lavender-500 to-lavender-700
              rounded-3xl shadow-lg shadow-lavender-300 active:scale-95
            "
          >
            Tap to continue →
          </motion.button>
        )}

        {error && (
          <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl max-w-xs">
            {error}
          </p>
        )}

        <p className="text-xs text-gray-400 font-medium max-w-[280px] mt-2">
          A grown-up signs in once per visit to keep {profile.name}'s magic key safe and private. 🔒
        </p>
      </div>
    </SafeArea>
  )
}
