// Silent Drive token refresh.
//
// The parent signs in once (implicit OAuth → access token + sub). The token
// expires in ~1h and we deliberately don't persist it. Without help, every
// page reload forces the parent to tap "Connect & Back Up" again. This module
// uses Google Identity Services' silent flow (`prompt: ''`) to ask GIS for a
// fresh access token via an *iframe* — no popup, no user gesture — as long as
// the user still has a Google session in this browser.
//
// Failure is silent: if GIS can't refresh quietly (e.g. user signed out of
// Google, third-party cookies blocked, Safari ITP), we just don't push to
// Drive automatically. The Settings "Connect & Back Up" button still works
// as the manual fallback.

import { useEffect } from 'react'
import { useAppStore } from '../store/app'
import { syncAppSettingsToDrive } from './drive'
import { logAction } from './debugLog'

const DRIVE_SCOPE =
  'openid profile email https://www.googleapis.com/auth/drive.appdata'

// Cache the token client so we don't recreate it on every refresh attempt.
let cachedClient: any = null

// Backoff so a string of failures doesn't keep retrying on every render.
let lastAttemptAt = 0
let lastAttemptFailed = false
const RETRY_WINDOW_MS = 5 * 60_000  // wait 5 min after a failure

function getGis(): any | null {
  if (typeof window === 'undefined') return null
  const g = (window as any).google
  return g?.accounts?.oauth2 ?? null
}

/**
 * iOS WebKit (Safari and any iOS browser, including Brave/Chrome which all
 * use WebKit underneath) blocks GIS's "silent" iframe flow because of ITP +
 * the third-party-cookie embargo. The token client falls back to a popup
 * attempt, which is then blocked because no user gesture is in flight,
 * producing a [GSI_LOGGER] error in the debug log every single mount. Skip
 * the silent attempt entirely on iOS — the manual "Connect & Back Up"
 * button still works because *that* IS in a user gesture.
 */
function isIosWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPad on iOS 13+ reports as Mac, so also probe for touch + Mac.
  const looksLikeIpad = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
  return /iPad|iPhone|iPod/.test(ua) || looksLikeIpad
}

/** Promise-wrap GIS's callback-style requestAccessToken. */
function requestSilentToken(clientId: string, hint?: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const gis = getGis()
    if (!gis) { resolve(null); return }

    try {
      if (!cachedClient) {
        cachedClient = gis.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: () => { /* set per-call below */ },
        })
      }
      // GIS doesn't reject silent attempts — it calls back with an error_subtype.
      cachedClient.callback = (resp: any) => {
        if (resp?.access_token) resolve(resp.access_token)
        else resolve(null)
      }
      cachedClient.error_callback = () => resolve(null)
      // `prompt: ''` = silent mode (iframe); only succeeds if the user is
      // still signed into Google and has previously granted this scope.
      const opts: any = { prompt: '' }
      if (hint) opts.hint = hint
      cachedClient.requestAccessToken(opts)
    } catch {
      resolve(null)
    }

    // Safety timeout — if GIS hangs (e.g. iframe blocked), give up after 4s.
    setTimeout(() => resolve(null), 4000)
  })
}

/**
 * Attempts a silent Drive token refresh. Returns the new access token or null.
 * Updates the store directly on success.
 */
export async function attemptSilentDriveConnect(): Promise<string | null> {
  const st = useAppStore.getState()
  if (st.googleToken) return st.googleToken  // already have one
  if (!st.googleSub) return null              // no identity to hint with

  // iOS WebKit: silent flow is reliably blocked + spammy. Skip and let the
  // manual Settings button handle it.
  if (isIosWebKit()) return null

  // Respect the backoff so we don't hammer GIS after a failed attempt.
  if (lastAttemptFailed && Date.now() - lastAttemptAt < RETRY_WINDOW_MS) return null

  const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined
  if (!clientId) return null

  lastAttemptAt = Date.now()
  const token = await requestSilentToken(clientId, st.googleSub)
  if (!token) {
    lastAttemptFailed = true
    return null
  }
  lastAttemptFailed = false
  st.setGoogleToken(token)
  logAction('[Drive] Silent token refresh succeeded')
  // Opportunistically push the latest settings — best-effort, swallow errors.
  try { await syncAppSettingsToDrive(token) } catch { /* non-fatal */ }
  return token
}

/**
 * Mount-level hook that fires a silent refresh attempt whenever we have a
 * persisted `sub` but no live access token. Place inside <GoogleOAuthProvider>
 * (so GIS has had a chance to load).
 */
export function useAutoDriveConnect(): void {
  const googleSub = useAppStore(s => s.googleSub)
  const googleToken = useAppStore(s => s.googleToken)

  useEffect(() => {
    if (!googleSub || googleToken) return
    let cancelled = false
    // GIS may not be loaded the instant React mounts — give it a moment.
    const delay = setTimeout(() => {
      if (cancelled) return
      void attemptSilentDriveConnect()
    }, 800)
    return () => { cancelled = true; clearTimeout(delay) }
  }, [googleSub, googleToken])
}
