import { useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useGoogleLogin } from '@react-oauth/google'
import { motion, AnimatePresence } from 'framer-motion'
import { db, safeDbWrite } from '../db/index'
import type { MascotChoice } from '../db/index'
import { useAppStore } from '../store/app'
import { encryptApiKey } from '../lib/crypto'
import { validateApiKey } from '../lib/gemini'
import { checkDriveForProfile } from '../lib/drive'
import { setActiveProfileId } from '../lib/profiles'
import { logEvent } from '../lib/debugLog'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

// ─── Types ────────────────────────────────────────────────────────────────────

type OnboardingStep = 1 | 2 | 3 | 4 | 5

// ─── Progress dots ────────────────────────────────────────────────────────────

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex justify-center gap-2 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <motion.div
          key={i}
          className={`h-2.5 rounded-full transition-all duration-300 ${
            i + 1 === step
              ? 'bg-lavender-500 w-8'
              : i + 1 < step
              ? 'bg-lavender-300 w-2.5'
              : 'bg-lavender-100 w-2.5'
          }`}
          initial={false}
          animate={{ width: i + 1 === step ? 32 : 10 }}
        />
      ))}
    </div>
  )
}

// ─── Screen transitions ───────────────────────────────────────────────────────

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 300 : -300,
    opacity: 0
  }),
  center: {
    x: 0,
    opacity: 1
  },
  exit: (direction: number) => ({
    x: direction < 0 ? 300 : -300,
    opacity: 0
  })
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OnboardingScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { setProfile, setGoogleToken, setGoogleSub, googleSub: storeSub, googleToken: storeToken } = useAppStore()

  // "Add child" mode: parent is already signed in and is adding another child.
  // Skip the Google sign-in step and seed the existing session credentials.
  const addMode = searchParams.get('add') === '1' && !!storeSub

  const [step, setStep] = useState<OnboardingStep>(addMode ? 2 : 1)
  const [direction, setDirection] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 — Google auth (seeded from store when adding another child)
  const [googleSub, setGoogleSubLocal] = useState(addMode ? (storeSub ?? '') : '')
  const [googleToken, setGoogleTokenLocal] = useState(addMode ? (storeToken ?? '') : '')

  // Step 2 — Child name + age (no upper cap — the AI adapts to whatever age)
  const [childName, setChildName] = useState('')
  const [childAge, setChildAge] = useState<number>(5)
  const MIN_AGE = 2
  const MAX_AGE = 15

  // Step 3 — API key
  const [apiKey, setApiKey] = useState('')

  // Step 4 — Languages
  const [selectedLangs, setSelectedLangs] = useState<string[]>(['en'])

  // Step 5 — Mascot
  const [mascot, setMascot] = useState<MascotChoice>('lion')

  const goToStep = useCallback((nextStep: OnboardingStep, dir = 1) => {
    setDirection(dir)
    setError(null)
    setStep(nextStep)
  }, [])

  // In add-child mode the API-key step (3) is skipped (parent's key already set),
  // so stepping back from Languages (4) returns to Name (2).
  const prevStep = useCallback((s: OnboardingStep): OnboardingStep => {
    if (addMode && s === 4) return 2
    return (s - 1) as OnboardingStep
  }, [addMode])

  // ── Step 1: Google Sign-In ──────────────────────────────────────────────────

  const login = useGoogleLogin({
    scope: 'openid profile email https://www.googleapis.com/auth/drive.appdata',
    onSuccess: async (tokenResponse) => {
      logEvent('info', '[Onboarding] Google onSuccess fired', {
        hasAccessToken: !!tokenResponse.access_token,
        scope: tokenResponse.scope,
        expires_in: tokenResponse.expires_in,
      })
      setIsLoading(true)
      setError(null)
      try {
        const accessToken = tokenResponse.access_token
        if (!accessToken) throw new Error('No access_token in tokenResponse')

        // Fetch user info to get sub (stable user ID)
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` }
        })
        logEvent('info', `[Onboarding] userinfo HTTP ${res.status}`)
        const userInfo = await res.json() as { sub?: string; error?: string }
        const sub = userInfo.sub
        if (!sub) {
          logEvent('error', '[Onboarding] userinfo response missing sub', userInfo)
          throw new Error('Could not read Google user ID')
        }

        setGoogleSubLocal(sub)
        setGoogleTokenLocal(accessToken)
        setGoogleToken(accessToken)
        setGoogleSub(sub)
        logEvent('info', '[Onboarding] sub + token saved → advancing to step 2')
        goToStep(2)
      } catch (err) {
        logEvent('error', '[Onboarding] sign-in pipeline failed', err)
        setError(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setIsLoading(false)
      }
    },
    onError: (err) => {
      logEvent('error', '[Onboarding] useGoogleLogin onError', err)
      setError('Sign-in failed. Please try again.')
    },
    onNonOAuthError: (err) => {
      // Popup blocked, popup closed, FedCM disabled, etc. — common on mobile
      logEvent('error', '[Onboarding] useGoogleLogin onNonOAuthError', err)
      setError('Google sign-in was blocked or cancelled. Check pop-up settings and try again.')
    }
  })

  // ── Step 2: Child name validation ──────────────────────────────────────────

  const handleNameNext = useCallback(async () => {
    const trimmed = childName.trim()
    if (trimmed.length < 2) {
      setError('Name must be at least 2 characters')
      return
    }
    if (trimmed.length > 50) {
      setError('Name must be under 50 characters')
      return
    }
    if (!/^[a-zA-Z\s'-]+$/.test(trimmed)) {
      setError('Name can only contain letters, spaces, and hyphens')
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      // Check Drive for existing profile with this name
      if (googleToken && googleSub) {
        const existing = await checkDriveForProfile(googleToken, trimmed)
        if (existing) {
          // Restore from Drive
          await db.transaction('rw', [db.childProfiles, db.interestTags, db.sessionSummaries, db.learnedObjects, db.appSettings], async () => {
            await db.childProfiles.put(existing.profile)
            if (existing.interestTags.length > 0) {
              await db.interestTags.bulkPut(existing.interestTags)
            }
            if (existing.sessionSummaries.length > 0) {
              await db.sessionSummaries.bulkPut(existing.sessionSummaries)
            }
            if (existing.learnedObjects.length > 0) {
              await db.learnedObjects.bulkPut(existing.learnedObjects)
            }
            if (existing.apiKeyEncrypted) {
              const current = await db.appSettings.get('main')
              await db.appSettings.put({
                id: 'main',
                apiKeyEncrypted: existing.apiKeyEncrypted,
                parentPinHash: current?.parentPinHash ?? '',
                sessionTimeLimit: current?.sessionTimeLimit ?? 30,
                enabledLanguages: existing.profile.preferredLanguages,
                cameraEnabled: current?.cameraEnabled ?? true,
                onboardingVersion: 1,
                lastSyncedAt: existing.syncedAt
              })
            }
            setActiveProfileId(existing.profile.id)
            setProfile(existing.profile)
          })
          navigate('/')
          return
        }
      }
      goToStep(addMode ? 4 : 3)
    } catch {
      // Drive check failed — proceed anyway
      goToStep(addMode ? 4 : 3)
    } finally {
      setIsLoading(false)
    }
  }, [childName, googleToken, googleSub, goToStep, navigate, setProfile, addMode])

  // ── Step 3: API key ─────────────────────────────────────────────────────────

  const handleApiKeyNext = useCallback(async () => {
    const trimmed = apiKey.trim()
    if (!trimmed.startsWith('AIza')) {
      setError('The magic key should start with "AIza". Ask a grown-up to check it!')
      return
    }
    if (trimmed.length < 20) {
      setError('That key looks too short. Please check it again.')
      return
    }

    if (!googleSub) {
      setError('Something went wrong. Please go back and sign in again.')
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      // Verify the key actually works before saving — avoids a confusing
      // "key not valid" failure later inside the chat/camera screens.
      const check = await validateApiKey(trimmed)
      if (!check.ok) {
        setError(`That key didn't work: ${check.message ?? 'please double-check it.'}`)
        setIsLoading(false)
        return
      }

      const encrypted = await encryptApiKey(trimmed, googleSub)
      const existing = await db.appSettings.get('main')
      await safeDbWrite(() => db.appSettings.put({
        id: 'main',
        apiKeyEncrypted: encrypted,
        parentPinHash: existing?.parentPinHash ?? '',
        sessionTimeLimit: existing?.sessionTimeLimit ?? 30,
        enabledLanguages: existing?.enabledLanguages ?? ['en'],
        cameraEnabled: existing?.cameraEnabled ?? true,
        onboardingVersion: 1,
        lastSyncedAt: existing?.lastSyncedAt ?? new Date().toISOString()
      }))
      goToStep(4)
    } catch (err) {
      setError(`Failed to save key: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsLoading(false)
    }
  }, [apiKey, googleSub, goToStep])

  // ── Step 4: Languages ───────────────────────────────────────────────────────

  const toggleLang = useCallback((lang: string) => {
    if (lang === 'en') return // English always on
    setSelectedLangs(prev =>
      prev.includes(lang)
        ? prev.filter(l => l !== lang)
        : [...prev, lang]
    )
  }, [])

  const handleLangsNext = useCallback(() => {
    if (selectedLangs.length === 0) {
      setError('Please select at least one language')
      return
    }
    goToStep(5)
  }, [selectedLangs, goToStep])

  // ── Step 5: Mascot → create profile ────────────────────────────────────────

  const handleFinish = useCallback(async () => {
    if (!googleSub) {
      setError('Something went wrong. Please restart onboarding.')
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const now = new Date().toISOString()
      const profileId = crypto.randomUUID()
      const profile = {
        id: profileId,
        googleId: googleSub,
        name: childName.trim(),
        age: childAge,
        mascotChoice: mascot,
        preferredLanguages: selectedLangs,
        createdAt: now,
        lastActiveAt: now
      }

      await safeDbWrite(() => db.childProfiles.put(profile))
      setActiveProfileId(profileId)

      // Update settings with selected languages
      await safeDbWrite(() => db.appSettings.update('main', {
        enabledLanguages: selectedLangs,
        onboardingVersion: 1
      }))

      setProfile(profile)
      navigate('/')
    } catch (err) {
      setError(`Failed to create profile: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsLoading(false)
    }
  }, [googleSub, childName, childAge, mascot, selectedLangs, navigate, setProfile])

  // ─── Language options ───────────────────────────────────────────────────────

  const LANGUAGE_OPTIONS = [
    { code: 'en', label: 'English', flag: '🇬🇧', native: 'English', alwaysOn: true },
    { code: 'kn', label: 'Kannada', flag: '🇮🇳', native: 'ಕನ್ನಡ', alwaysOn: false },
    { code: 'hi', label: 'Hindi', flag: '🇮🇳', native: 'हिन्दी', alwaysOn: false },
    { code: 'ta', label: 'Tamil', flag: '🇮🇳', native: 'தமிழ்', alwaysOn: false },
    { code: 'te', label: 'Telugu', flag: '🇮🇳', native: 'తెలుగు', alwaysOn: false }
  ]

  const MASCOT_OPTIONS: { choice: MascotChoice; emoji: string; name: string; desc: string }[] = [
    { choice: 'lion', emoji: '🦁', name: 'Leo', desc: 'Brave & curious!' },
    { choice: 'owl', emoji: '🦉', name: 'Ollie', desc: 'Wise & gentle!' },
    { choice: 'bunny', emoji: '🐰', name: 'Benny', desc: 'Playful & fun!' }
  ]

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-50 via-white to-leo-50 overflow-hidden">
      <div className="flex flex-col flex-1 px-4 py-2 max-w-sm mx-auto w-full">
        {/* Back navigation — never returns to sign-in when adding another child */}
        <div className="h-8 flex items-center">
          {step > (addMode ? 2 : 1) && (
            <button
              onClick={() => goToStep(prevStep(step), -1)}
              disabled={isLoading}
              className="flex items-center gap-1 text-lavender-500 font-bold text-sm active:scale-95 disabled:opacity-40"
              aria-label="Go back one step"
            >
              ← Back
            </button>
          )}
          {addMode && step === 2 && (
            <button
              onClick={() => navigate('/settings')}
              disabled={isLoading}
              className="flex items-center gap-1 text-lavender-400 font-bold text-sm active:scale-95 disabled:opacity-40"
            >
              ← Cancel
            </button>
          )}
        </div>

        {/* Progress dots */}
        <ProgressDots step={step} total={5} />

        {/* Step content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="flex-1 min-h-0 flex flex-col"
            >
              {/* ── Step 1: Sign In ─────────────────────────────────────── */}
              {step === 1 && (
                <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center">
                  <LeoMascot size="lg" mood="excited" />
                  <div>
                    <h1 className="text-4xl font-extrabold text-lavender-700 leading-tight">
                      Hello! I'm Leo! 🦁
                    </h1>
                    <p className="mt-2 text-xl text-lavender-500 font-semibold">
                      Let's start our adventure together!
                    </p>
                  </div>
                  <div className="w-full bg-white rounded-3xl p-5 shadow-lg shadow-lavender-100">
                    <p className="text-base text-gray-600 mb-4 font-semibold">
                      Ask a grown-up to sign in first 👇
                    </p>
                    {isLoading ? (
                      <div className="flex justify-center py-4">
                        <div className="animate-spin w-8 h-8 border-4 border-lavender-300 border-t-lavender-600 rounded-full" />
                      </div>
                    ) : (
                      <div className="flex justify-center">
                        <button
                          onClick={() => login()}
                          className="
                            flex items-center gap-3 px-6 py-3 bg-white border-2 border-gray-300
                            rounded-2xl shadow font-bold text-gray-700 text-base
                            active:scale-95 transition-transform hover:border-lavender-400
                          "
                        >
                          <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20H24v8h11.3C33.7 33.1 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.1-4z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.1 18.9 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.5-5.1l-6.2-5.2C29.5 35.5 26.9 36 24 36c-5.3 0-9.7-2.9-11.3-7l-6.5 5C9.6 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.5-2.6 4.6-4.8 6l6.2 5.2C40.5 35.8 44 30.3 44 24c0-1.3-.1-2.7-.4-4z"/></svg>
                          Sign in with Google
                        </button>
                      </div>
                    )}
                  </div>
                  {error && (
                    <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl">
                      {error}
                    </p>
                  )}
                </div>
              )}

              {/* ── Step 2: Child Name ──────────────────────────────────── */}
              {step === 2 && (
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-6 py-4">
                  <LeoMascot size="md" mood="happy" />
                  <div className="text-center">
                    <h2 className="text-3xl font-extrabold text-lavender-700">
                      What's your name? 😊
                    </h2>
                    <p className="mt-1 text-lg text-lavender-400 font-medium">
                      What shall I call my new friend?
                    </p>
                  </div>
                  <div className="w-full">
                    <input
                      type="text"
                      value={childName}
                      onChange={e => setChildName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleNameNext() }}
                      placeholder="Type your name here..."
                      maxLength={50}
                      autoFocus
                      className="
                        w-full px-5 py-4 text-2xl font-bold text-center
                        bg-white border-4 border-lavender-200 rounded-3xl
                        focus:outline-none focus:border-lavender-500
                        placeholder:text-lavender-200
                        shadow-lg shadow-lavender-100
                      "
                    />
                  </div>

                  {/* Age stepper (no upper cap — AI adapts to any age) */}
                  <div className="w-full text-center">
                    <p className="text-base font-bold text-lavender-500 mb-2">How old are you?</p>
                    <div className="flex justify-center items-center gap-4">
                      <button
                        onClick={() => setChildAge(a => Math.max(MIN_AGE, a - 1))}
                        disabled={childAge <= MIN_AGE}
                        className="w-14 h-14 rounded-2xl text-3xl font-extrabold bg-lavender-100 text-lavender-600 active:scale-90 disabled:opacity-30"
                        aria-label="Younger"
                      >
                        −
                      </button>
                      <div className="w-24 h-20 rounded-3xl bg-lavender-50 border-4 border-lavender-300 flex flex-col items-center justify-center shadow-md">
                        <span className="text-4xl font-extrabold text-lavender-700 leading-none">{childAge}</span>
                        <span className="text-xs font-bold text-lavender-400 mt-0.5">years</span>
                      </div>
                      <button
                        onClick={() => setChildAge(a => Math.min(MAX_AGE, a + 1))}
                        disabled={childAge >= MAX_AGE}
                        className="w-14 h-14 rounded-2xl text-3xl font-extrabold bg-lavender-100 text-lavender-600 active:scale-90 disabled:opacity-30"
                        aria-label="Older"
                      >
                        ＋
                      </button>
                    </div>
                  </div>
                  {error && (
                    <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl text-center">
                      {error}
                    </p>
                  )}
                  <button
                    onClick={() => void handleNameNext()}
                    disabled={!childName.trim() || isLoading}
                    className="
                      w-full py-4 text-xl font-extrabold text-white
                      bg-gradient-to-r from-lavender-500 to-lavender-700
                      rounded-3xl shadow-lg shadow-lavender-300
                      disabled:opacity-50 disabled:cursor-not-allowed
                      active:scale-95 transition-transform
                    "
                  >
                    {isLoading ? '...' : "That's me! →"}
                  </button>
                </div>
              )}

              {/* ── Step 3: API Key ─────────────────────────────────────── */}
              {step === 3 && (
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-5 py-4">
                  <div className="text-center">
                    <span className="text-6xl">🔑</span>
                    <h2 className="text-2xl font-extrabold text-leo-700 mt-2">
                      Magic Key Time!
                    </h2>
                    <p className="mt-1 text-base text-gray-600 font-medium">
                      Ask a grown-up to paste Leo's magic key so we can chat!
                    </p>
                  </div>
                  <div className="w-full bg-leo-50 rounded-2xl p-4 border-2 border-leo-200">
                    <p className="text-sm text-leo-700 font-semibold mb-1">
                      Where to get the magic key:
                    </p>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-lavender-600 font-bold underline"
                    >
                      aistudio.google.com → Get API key (free!) →
                    </a>
                  </div>
                  <textarea
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Paste the magic key here (starts with AIza...)"
                    rows={3}
                    className="
                      w-full px-4 py-3 text-base font-mono
                      bg-white border-4 border-leo-200 rounded-2xl
                      focus:outline-none focus:border-leo-500
                      placeholder:text-gray-300 placeholder:font-sans placeholder:text-sm
                      shadow-lg resize-none
                    "
                  />
                  {error && (
                    <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl text-center w-full">
                      {error}
                    </p>
                  )}
                  <button
                    onClick={() => void handleApiKeyNext()}
                    disabled={!apiKey.trim() || isLoading}
                    className="
                      w-full py-4 text-xl font-extrabold text-white
                      bg-gradient-to-r from-leo-400 to-leo-600
                      rounded-3xl shadow-lg shadow-leo-300
                      disabled:opacity-50 disabled:cursor-not-allowed
                      active:scale-95 transition-transform
                    "
                  >
                    {isLoading ? '...' : 'Got it! →'}
                  </button>
                </div>
              )}

              {/* ── Step 4: Languages ───────────────────────────────────── */}
              {step === 4 && (
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-5 py-4">
                  <div className="text-center">
                    <span className="text-6xl">🌍</span>
                    <h2 className="text-2xl font-extrabold text-mint-700 mt-2">
                      Which languages?
                    </h2>
                    <p className="mt-1 text-base text-gray-500 font-medium">
                      Leo can teach words in many languages!
                    </p>
                  </div>
                  <div className="w-full flex flex-col gap-3">
                    {LANGUAGE_OPTIONS.map(lang => (
                      <button
                        key={lang.code}
                        onClick={() => toggleLang(lang.code)}
                        disabled={lang.alwaysOn}
                        className={`
                          flex items-center gap-4 px-5 py-4 rounded-3xl
                          border-4 transition-all font-bold text-left
                          ${selectedLangs.includes(lang.code)
                            ? 'bg-mint-100 border-mint-400 text-mint-800'
                            : 'bg-white border-gray-200 text-gray-500'
                          }
                          ${lang.alwaysOn ? 'opacity-70 cursor-default' : 'active:scale-95'}
                        `}
                      >
                        <span className="text-3xl">{lang.flag}</span>
                        <div>
                          <p className="text-lg font-extrabold">{lang.label}</p>
                          <p className="text-sm opacity-70">{lang.native}</p>
                        </div>
                        <span className="ml-auto text-2xl">
                          {selectedLangs.includes(lang.code) ? '✅' : '⬜'}
                        </span>
                      </button>
                    ))}
                  </div>
                  {error && (
                    <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl text-center">
                      {error}
                    </p>
                  )}
                  <button
                    onClick={handleLangsNext}
                    className="
                      w-full py-4 text-xl font-extrabold text-white
                      bg-gradient-to-r from-mint-500 to-mint-600
                      rounded-3xl shadow-lg shadow-mint-300
                      active:scale-95 transition-transform
                    "
                  >
                    These ones! →
                  </button>
                </div>
              )}

              {/* ── Step 5: Mascot chooser ───────────────────────────────── */}
              {step === 5 && (
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-5 py-4">
                  <div className="text-center">
                    <h2 className="text-2xl font-extrabold text-lavender-700">
                      Choose your friend! 🎉
                    </h2>
                    <p className="mt-1 text-base text-gray-500 font-medium">
                      Who will be your learning buddy?
                    </p>
                  </div>
                  <div className="w-full flex flex-col gap-4">
                    {MASCOT_OPTIONS.map(option => (
                      <motion.button
                        key={option.choice}
                        onClick={() => setMascot(option.choice)}
                        whileTap={{ scale: 0.96 }}
                        className={`
                          flex items-center gap-5 px-5 py-5 rounded-3xl
                          border-4 transition-all text-left w-full
                          ${mascot === option.choice
                            ? 'bg-lavender-100 border-lavender-500 shadow-lg shadow-lavender-200'
                            : 'bg-white border-gray-200'
                          }
                        `}
                      >
                        <span className="text-5xl">{option.emoji}</span>
                        <div>
                          <p className="text-xl font-extrabold text-lavender-800">{option.name}</p>
                          <p className="text-sm font-semibold text-gray-500">{option.desc}</p>
                        </div>
                        {mascot === option.choice && (
                          <span className="ml-auto text-2xl">✨</span>
                        )}
                      </motion.button>
                    ))}
                  </div>
                  {error && (
                    <p className="text-red-500 text-sm font-semibold bg-red-50 px-4 py-2 rounded-xl text-center">
                      {error}
                    </p>
                  )}
                  <button
                    onClick={() => void handleFinish()}
                    disabled={isLoading}
                    className="
                      w-full py-4 text-xl font-extrabold text-white
                      bg-gradient-to-r from-lavender-500 to-coral-500
                      rounded-3xl shadow-lg
                      disabled:opacity-50
                      active:scale-95 transition-transform
                    "
                  >
                    {isLoading ? 'Starting...' : "Let's go! 🚀"}
                  </button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </SafeArea>
  )
}
