import { create } from 'zustand'
import type { ChildProfile } from '../db/index'

// The Google `sub` is the key material that decrypts the stored API key.
// We persist it locally so a page refresh doesn't force a re-login every time.
// Trade-off: on a personal/family device this is the right UX; the encrypted
// key + sub both live on-device (same risk profile as any locally-saved login).
const STORED_SUB_KEY = 'ck_google_sub'

function loadStoredSub(): string | null {
  try { return localStorage.getItem(STORED_SUB_KEY) } catch { return null }
}

function persistSub(sub: string | null): void {
  try {
    if (sub) localStorage.setItem(STORED_SUB_KEY, sub)
    else localStorage.removeItem(STORED_SUB_KEY)
  } catch { /* ignore */ }
}

interface AppState {
  // Auth
  profile: ChildProfile | null
  googleToken: string | null    // Google access token for Drive API
  googleSub: string | null      // Google user sub (stable user ID)

  // Network
  isOnline: boolean

  // Navigation
  currentScreen: string

  // Session tracking
  sessionTopics: string[]
  sessionStart: number | null   // timestamp ms

  // Actions
  setProfile: (profile: ChildProfile | null) => void
  setGoogleToken: (token: string | null) => void
  setGoogleSub: (sub: string | null) => void
  setIsOnline: (online: boolean) => void
  setCurrentScreen: (screen: string) => void
  addSessionTopic: (topic: string) => void
  startSession: () => void
  endSession: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  profile: null,
  googleToken: null,
  googleSub: loadStoredSub(),   // restored across refreshes → no repeated logins
  isOnline: navigator.onLine,
  currentScreen: 'home',
  sessionTopics: [],
  sessionStart: null,

  // Actions
  setProfile: (profile) => set({ profile }),
  setGoogleToken: (googleToken) => set({ googleToken }),
  setGoogleSub: (googleSub) => { persistSub(googleSub); set({ googleSub }) },
  setIsOnline: (isOnline) => set({ isOnline }),
  setCurrentScreen: (currentScreen) => set({ currentScreen }),

  addSessionTopic: (topic) => {
    const { sessionTopics } = get()
    const normalized = topic.toLowerCase().trim()
    if (normalized && !sessionTopics.includes(normalized)) {
      set({ sessionTopics: [...sessionTopics, normalized] })
    }
  },

  startSession: () => set({
    sessionStart: Date.now(),
    sessionTopics: []
  }),

  endSession: () => set({
    sessionStart: null,
    sessionTopics: []
  })
}))

// ─── Network listeners ────────────────────────────────────────────────────────
// Set up once at module load so the store always reflects real connectivity
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    useAppStore.getState().setIsOnline(true)
  })
  window.addEventListener('offline', () => {
    useAppStore.getState().setIsOnline(false)
  })
  // Re-check on tab focus — navigator.onLine can lag behind real connectivity
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) useAppStore.getState().setIsOnline(navigator.onLine)
  })
}
