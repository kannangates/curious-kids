import { useEffect, useState, lazy, Suspense, type ReactNode, type ComponentType } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { db } from './db/index'
import { useAppStore } from './store/app'
// Eager: first-paint screens
import { OnboardingScreen } from './screens/OnboardingScreen'
import { HomeScreen } from './screens/HomeScreen'

/**
 * lazy() wrapper that survives stale-chunk errors after a deploy.
 *
 * When a new build ships, asset hashes change. If the user is holding an old
 * index.html (cached HTML or stale service worker), the chunk URLs it points
 * at no longer exist — request → 404 → SPA fallback returns index.html → the
 * browser refuses to parse it as a JS module ("Expected a JavaScript-or-Wasm
 * module script but the server responded with a MIME type of 'text/html'"),
 * leaving a blank screen until the user manually refreshes.
 *
 * On any such failure we trigger a single reload (gated by sessionStorage so
 * we never loop) to fetch the new index.html with the correct hashes.
 */
function lazyRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>
) {
  return lazy(() =>
    loader().catch(err => {
      const FLAG = 'ck_chunk_reloaded_at'
      const last = Number(sessionStorage.getItem(FLAG) || '0')
      // Reload at most once per 30s to avoid an infinite loop if the chunk really is gone
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(FLAG, String(Date.now()))
        window.location.reload()
        // Block until the reload happens; React shouldn't render an error briefly
        return new Promise<{ default: T }>(() => { /* never resolves */ })
      }
      throw err
    })
  )
}

// Lazy: everything else is loaded on demand to keep the initial bundle small.
const ChatScreen = lazyRetry(() => import('./screens/ChatScreen').then(m => ({ default: m.ChatScreen })))
const CameraScreen = lazyRetry(() => import('./screens/CameraScreen').then(m => ({ default: m.CameraScreen })))
const WordExplorerScreen = lazyRetry(() => import('./screens/WordExplorerScreen').then(m => ({ default: m.WordExplorerScreen })))
const DiscoveriesScreen = lazyRetry(() => import('./screens/DiscoveriesScreen').then(m => ({ default: m.DiscoveriesScreen })))
const BedtimeStoryScreen = lazyRetry(() => import('./screens/BedtimeStoryScreen').then(m => ({ default: m.BedtimeStoryScreen })))
const WordGameScreen = lazyRetry(() => import('./screens/WordGameScreen').then(m => ({ default: m.WordGameScreen })))
const PuzzleScreen = lazyRetry(() => import('./screens/PuzzleScreen').then(m => ({ default: m.PuzzleScreen })))
const ParentSettingsScreen = lazyRetry(() => import('./screens/ParentSettingsScreen').then(m => ({ default: m.ParentSettingsScreen })))
const ParentDashboardScreen = lazyRetry(() => import('./screens/ParentDashboardScreen').then(m => ({ default: m.ParentDashboardScreen })))
import { useSessionLimit } from './hooks/useSessionLimit'
import { grantBonusMinutes } from './lib/usage'
import { resolveActiveProfile, setActiveProfileId } from './lib/profiles'
import { TimeUpScreen } from './components/TimeUpScreen'
import { WelcomeBackScreen } from './components/WelcomeBackScreen'
import { ParentGate } from './components/ParentGate'
import { DebugOverlay } from './components/DebugOverlay'

// Shared loading fallback for lazily-loaded screens
function LeoLoading() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-lavender-50">
      <div className="flex flex-col items-center gap-4">
        <span className="text-6xl animate-bounce">🦁</span>
        <p className="text-lavender-600 font-bold text-lg">Loading…</p>
      </div>
    </div>
  )
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

interface RequireAuthProps {
  children: ReactNode
}

function RequireAuth({ children }: RequireAuthProps) {
  const profile = useAppStore(s => s.profile)
  const googleSub = useAppStore(s => s.googleSub)
  const [isLoading, setIsLoading] = useState(true)
  const [hasProfile, setHasProfile] = useState(false)

  useEffect(() => {
    async function checkProfile() {
      try {
        const count = await db.childProfiles.count()
        setHasProfile(count > 0 || profile !== null)
      } catch {
        setHasProfile(false)
      } finally {
        setIsLoading(false)
      }
    }
    void checkProfile()
  }, [profile])

  const Loading = (
    <div className="min-h-dvh flex items-center justify-center bg-lavender-50">
      <div className="flex flex-col items-center gap-4">
        <span className="text-6xl animate-bounce">🦁</span>
        <p className="text-lavender-600 font-bold text-lg">Loading Leo...</p>
      </div>
    </div>
  )

  if (isLoading) return Loading

  if (!hasProfile) {
    return <Navigate to="/onboarding" replace />
  }

  // A profile exists in the DB but the store hasn't hydrated it yet — wait.
  if (!profile) return Loading

  // Profile restored but the in-memory Google `sub` is gone (e.g. page refresh).
  // The sub is required to decrypt the API key, so recover the session with a tap.
  if (!googleSub) {
    return <WelcomeBackScreen profile={profile} />
  }

  return <>{children}</>
}

// ─── Time-limit guard (child-play routes only) ─────────────────────────────────
// Wraps child-facing screens. When the parent-set daily limit is hit, swaps the
// content for a gentle Time's Up screen. Parent settings/dashboard stay reachable
// so the limit can always be adjusted.

function TimeGuard({ children }: { children: ReactNode }) {
  const profile = useAppStore(s => s.profile)
  const { limitReached, limitMinutes, refresh } = useSessionLimit(profile?.id)

  if (limitReached && profile) {
    return (
      <TimeUpScreen
        childName={profile.name}
        limitMinutes={limitMinutes}
        onGrantBonus={(mins) => {
          grantBonusMinutes(profile.id, mins)
          refresh()
        }}
      />
    )
  }

  return <>{children}</>
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const setProfile = useAppStore(s => s.setProfile)

  // On app load, restore the ACTIVE profile from IndexedDB into the store
  useEffect(() => {
    async function restoreProfile() {
      try {
        // One-time migration: older builds defaulted cameraEnabled to false with
        // no UI to change it, which the new enforcement would wrongly read as
        // "camera off". Flip a stale default-false to true exactly once; after
        // that, a deliberate parent toggle sticks.
        if (!localStorage.getItem('ck_cam_migrated')) {
          try {
            const s = await db.appSettings.get('main')
            if (s && s.cameraEnabled === false) {
              await db.appSettings.update('main', { cameraEnabled: true })
            }
            localStorage.setItem('ck_cam_migrated', '1')
          } catch { /* ignore */ }
        }

        const active = await resolveActiveProfile()
        if (active) {
          setActiveProfileId(active.id)
          setProfile(active)
        }
      } catch (err) {
        console.error('Failed to restore profile from IndexedDB:', err)
      }
    }
    void restoreProfile()
  }, [setProfile])

  return (
    <>
    <Suspense fallback={<LeoLoading />}>
    <Routes>
      {/* Onboarding — no auth required */}
      <Route path="/onboarding" element={<OnboardingScreen />} />

      {/* Protected child-play routes — require a profile AND respect the time limit */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <TimeGuard><HomeScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/chat"
        element={
          <RequireAuth>
            <TimeGuard><ChatScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/camera"
        element={
          <RequireAuth>
            <TimeGuard><CameraScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/words"
        element={
          <RequireAuth>
            <TimeGuard><WordExplorerScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/discoveries"
        element={
          <RequireAuth>
            <TimeGuard><DiscoveriesScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/bedtime"
        element={
          <RequireAuth>
            <TimeGuard><BedtimeStoryScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/wordgame"
        element={
          <RequireAuth>
            <TimeGuard><WordGameScreen /></TimeGuard>
          </RequireAuth>
        }
      />
      <Route
        path="/puzzle"
        element={
          <RequireAuth>
            <TimeGuard><PuzzleScreen /></TimeGuard>
          </RequireAuth>
        }
      />

      {/* Parent routes — no time guard, but behind the Parent PIN gate */}
      <Route
        path="/parent-dashboard"
        element={
          <RequireAuth>
            <ParentGate><ParentDashboardScreen /></ParentGate>
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <ParentGate><ParentSettingsScreen /></ParentGate>
          </RequireAuth>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    {/* Visible on every screen — shows captured errors / warnings */}
    <DebugOverlay />
    </>
  )
}
