import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGoogleLogin } from '@react-oauth/google'
import { motion } from 'framer-motion'
import { db, DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL } from '../db/index'
import type { AppSettings, ChildProfile, MascotChoice } from '../db/index'
import { useAppStore } from '../store/app'
import { encryptApiKey, decryptApiKey, hashPin } from '../lib/crypto'
import { validateApiKey, listAvailableModels } from '../lib/gemini'
import { buildSyncSnapshot, saveToDrive, TokenExpiredError } from '../lib/drive'
import { isSfxMuted, setSfxMuted, playSuccess } from '../lib/audio'
import { getVoicesForLang, getPreferredVoiceURI, setPreferredVoiceURI, previewVoice, stopSpeaking } from '../lib/voice'
import { listProfiles, setActiveProfileId, deleteProfile, resetMemoryForProfile } from '../lib/profiles'
import { markParentUnlocked } from '../components/ParentGate'
import { SafeArea } from '../components/SafeArea'

// ─── ParentSettingsScreen ─────────────────────────────────────────────────────

export function ParentSettingsScreen() {
  const navigate = useNavigate()
  const { profile, googleToken, googleSub, setProfile, setGoogleToken, setGoogleSub } = useAppStore()

  const [children, setChildren] = useState<ChildProfile[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  // Edit-active-child fields (form collapsed by default — opens on Edit click)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editAge, setEditAge] = useState(5)
  const [editMascot, setEditMascot] = useState<MascotChoice>('lion')
  const [editLangs, setEditLangs] = useState<string[]>(['en'])

  // Memory reset
  const [resetWindow, setResetWindow] = useState<'1' | '7' | '30' | 'all'>('7')
  const [isResetting, setIsResetting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Editable fields
  const [newApiKey, setNewApiKey] = useState('')
  const [sessionLimit, setSessionLimit] = useState(30)
  const [showApiKey, setShowApiKey] = useState(false)
  const [currentKeyMasked, setCurrentKeyMasked] = useState('')
  const [soundOn, setSoundOn] = useState(!isSfxMuted())

  // Voice
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState(getPreferredVoiceURI() ?? '')

  // Camera + PIN
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [hasPin, setHasPin] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')

  // Model configuration
  const [chatModel, setChatModel] = useState(DEFAULT_CHAT_MODEL)
  const [visionModel, setVisionModel] = useState(DEFAULT_VISION_MODEL)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  useEffect(() => {
    async function loadChildren() {
      try {
        setChildren(await listProfiles())
      } catch (err) {
        console.error('Failed to load children:', err)
      }
    }
    void loadChildren()
  }, [profile])

  // Seed the edit form from the active profile
  useEffect(() => {
    if (profile) {
      setEditName(profile.name)
      setEditAge(profile.age)
      setEditMascot(profile.mascotChoice)
      setEditLangs(profile.preferredLanguages.length ? profile.preferredLanguages : ['en'])
    }
  }, [profile])

  useEffect(() => {
    async function loadSettings() {
      try {
        const s = await db.appSettings.get('main')
        if (s) {
          setSettings(s)
          setSessionLimit(s.sessionTimeLimit)
          setChatModel(s.chatModel || DEFAULT_CHAT_MODEL)
          setVisionModel(s.visionModel || DEFAULT_VISION_MODEL)
          setCameraEnabled(s.cameraEnabled !== false)
          setHasPin(!!s.parentPinHash)

          // Show masked version of current key
          if (s.apiKeyEncrypted && googleSub) {
            try {
              const plain = await decryptApiKey(s.apiKeyEncrypted, googleSub)
              setCurrentKeyMasked(plain.slice(0, 8) + '••••••••••••••••••••')
            } catch {
              setCurrentKeyMasked('(encrypted)')
            }
          }
        }
      } catch (err) {
        console.error('Failed to load settings:', err)
      } finally {
        setIsLoading(false)
      }
    }
    void loadSettings()
  }, [googleSub])

  const primaryLang = profile?.preferredLanguages[0] ?? 'en'

  // Load voices for the child's language (they arrive async on first load)
  useEffect(() => {
    function refresh() {
      setVoices(getVoicesForLang(primaryLang))
    }
    refresh()
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
    synth?.addEventListener?.('voiceschanged', refresh)
    return () => {
      synth?.removeEventListener?.('voiceschanged', refresh)
      stopSpeaking()
    }
  }, [primaryLang])

  const handleSelectVoice = useCallback((uri: string) => {
    setSelectedVoiceURI(uri)
    setPreferredVoiceURI(uri || null)
  }, [])

  const handlePreviewVoice = useCallback(() => {
    const name = profile?.mascotChoice === 'owl' ? 'Ollie' : profile?.mascotChoice === 'bunny' ? 'Benny' : 'Leo'
    const sample = `Hi! I'm ${name}. Let's discover something amazing together!`
    // Preview the chosen voice, or the top auto-pick when set to Auto
    const uri = selectedVoiceURI || voices[0]?.voiceURI || ''
    if (uri) void previewVoice(sample, primaryLang, uri)
  }, [selectedVoiceURI, voices, primaryLang, profile])

  const showSuccess = useCallback((msg: string) => {
    setSuccessMessage(msg)
    setTimeout(() => setSuccessMessage(null), 3000)
  }, [])

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg)
    setTimeout(() => setErrorMessage(null), 4000)
  }, [])

  // ── Switch active child ────────────────────────────────────────────────────

  const handleSwitchChild = useCallback(async (child: ChildProfile) => {
    if (child.id === profile?.id) return
    try {
      const now = new Date().toISOString()
      await db.childProfiles.update(child.id, { lastActiveAt: now })
      setActiveProfileId(child.id)
      setProfile({ ...child, lastActiveAt: now })
      navigate('/')
    } catch (err) {
      showError(`Couldn't switch child: ${err instanceof Error ? err.message : String(err)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, setProfile, navigate])

  // ── Update API key ───────────────────────────────────────────────────────

  const handleUpdateApiKey = useCallback(async () => {
    if (!newApiKey.trim().startsWith('AIza')) {
      showError('Invalid key format — should start with "AIza"')
      return
    }
    if (!googleSub) {
      showError('Not signed in — please sign in again')
      return
    }

    setIsSaving(true)
    try {
      // Validate the key against Google before saving it
      const check = await validateApiKey(newApiKey.trim())
      if (!check.ok) {
        showError(`That key didn't work: ${check.message ?? 'please double-check it.'}`)
        setIsSaving(false)
        return
      }

      const encrypted = await encryptApiKey(newApiKey.trim(), googleSub)
      await db.appSettings.update('main', { apiKeyEncrypted: encrypted })
      setCurrentKeyMasked(newApiKey.trim().slice(0, 8) + '••••••••••••••••••••')
      setNewApiKey('')
      showSuccess('Magic key updated! ✅')
    } catch (err) {
      showError(`Failed to update key: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [newApiKey, googleSub, showSuccess, showError])

  // ── Update session limit ─────────────────────────────────────────────────

  const handleUpdateSessionLimit = useCallback(async () => {
    setIsSaving(true)
    try {
      await db.appSettings.update('main', { sessionTimeLimit: sessionLimit })
      showSuccess('Session limit saved! ✅')
    } catch (err) {
      showError(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [sessionLimit, showSuccess, showError])

  // ── Model configuration ─────────────────────────────────────────────────

  const handleSaveModels = useCallback(async () => {
    const chat = chatModel.trim() || DEFAULT_CHAT_MODEL
    const vision = visionModel.trim() || DEFAULT_VISION_MODEL
    setIsSaving(true)
    try {
      await db.appSettings.update('main', { chatModel: chat, visionModel: vision })
      setChatModel(chat)
      setVisionModel(vision)
      showSuccess('Models saved! ✅ (reopen Chat/Camera to apply)')
    } catch (err) {
      showError(`Failed to save models: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [chatModel, visionModel, showSuccess, showError])

  const handleLoadModels = useCallback(async () => {
    if (!googleSub) {
      showError('Sign in first to load models')
      return
    }
    setLoadingModels(true)
    try {
      const s = await db.appSettings.get('main')
      if (!s?.apiKeyEncrypted) {
        showError('Set an API key first')
        return
      }
      const apiKey = await decryptApiKey(s.apiKeyEncrypted, googleSub)
      const models = await listAvailableModels(apiKey)
      setAvailableModels(models)
      if (models.length === 0) showError('No usable models found for this key')
    } catch (err) {
      showError(`Couldn't load models: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoadingModels(false)
    }
  }, [googleSub, showError])

  // ── Camera toggle ──────────────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    const next = !cameraEnabled
    setCameraEnabled(next)
    try {
      await db.appSettings.update('main', { cameraEnabled: next })
    } catch (err) {
      showError(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`)
      setCameraEnabled(!next)
    }
  }, [cameraEnabled, showError])

  // ── Parent PIN ─────────────────────────────────────────────────────────

  const handleSetPin = useCallback(async () => {
    if (!/^\d{4}$/.test(pinInput)) {
      showError('PIN must be exactly 4 digits')
      return
    }
    if (pinInput !== pinConfirm) {
      showError('The two PINs don\'t match')
      return
    }
    setIsSaving(true)
    try {
      const hash = await hashPin(pinInput)
      await db.appSettings.update('main', { parentPinHash: hash })
      markParentUnlocked() // stay unlocked in this session
      setHasPin(true)
      setPinInput('')
      setPinConfirm('')
      showSuccess('Parent PIN set! 🔒')
    } catch (err) {
      showError(`Failed to set PIN: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [pinInput, pinConfirm, showSuccess, showError])

  const handleRemovePin = useCallback(async () => {
    setIsSaving(true)
    try {
      await db.appSettings.update('main', { parentPinHash: '' })
      setHasPin(false)
      setPinInput('')
      setPinConfirm('')
      showSuccess('Parent PIN removed')
    } catch (err) {
      showError(`Failed to remove PIN: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [showSuccess, showError])

  // ── Manual Drive sync (connects to Google first if needed) ────────────────

  const runDriveSync = useCallback(async (token: string) => {
    if (!profile) { showError('No child profile to sync'); return }
    setSyncStatus('syncing')
    try {
      const snapshot = await buildSyncSnapshot(profile.id)
      await saveToDrive(token, profile.name, snapshot)
      await db.appSettings.update('main', { lastSyncedAt: new Date().toISOString() })
      setSyncStatus('done')
      showSuccess('Synced to Google Drive! ☁️')
    } catch (err) {
      setSyncStatus('error')
      if (err instanceof TokenExpiredError) {
        // Token no longer valid — drop it so the next tap reconnects
        setGoogleToken(null)
        showError('Google session expired — tap Sync Now again to reconnect.')
      } else {
        showError(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setTimeout(() => setSyncStatus('idle'), 3000)
    }
  }, [profile, showSuccess, showError, setGoogleToken])

  // Connect to Google (gets a fresh Drive token), then sync automatically
  const connectGoogle = useGoogleLogin({
    scope: 'openid profile email https://www.googleapis.com/auth/drive.appdata',
    onSuccess: async (tokenResponse) => {
      const token = tokenResponse.access_token
      setGoogleToken(token)
      // Recover sub too if it's somehow missing (keeps decryption working)
      try {
        const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()) as { sub?: string }
        if (info?.sub) setGoogleSub(info.sub)
      } catch { /* non-fatal */ }
      await runDriveSync(token)
    },
    onError: () => {
      setSyncStatus('error')
      showError('Google sign-in was cancelled.')
      setTimeout(() => setSyncStatus('idle'), 3000)
    }
  })

  const handleDriveSync = useCallback(() => {
    if (!profile) { showError('No child profile to sync'); return }
    if (googleToken) {
      void runDriveSync(googleToken)
    } else {
      // No valid token (e.g. after a refresh) → connect to Google, then it syncs
      setSyncStatus('syncing')
      connectGoogle()
    }
  }, [googleToken, profile, runDriveSync, connectGoogle, showError])

  // ── Delete profile ───────────────────────────────────────────────────────

  // ── Edit the active child ──────────────────────────────────────────────

  const handleSaveProfile = useCallback(async () => {
    if (!profile) return
    const name = editName.trim()
    if (name.length < 2) { showError('Name must be at least 2 characters'); return }
    if (!/^[a-zA-Z\s'-]+$/.test(name)) { showError('Name can only contain letters, spaces, and hyphens'); return }
    const langs = editLangs.includes('en') ? editLangs : ['en', ...editLangs]

    setIsSaving(true)
    try {
      const updated = { ...profile, name, age: editAge, mascotChoice: editMascot, preferredLanguages: langs }
      await db.childProfiles.update(profile.id, {
        name, age: editAge, mascotChoice: editMascot, preferredLanguages: langs
      })
      await db.appSettings.update('main', { enabledLanguages: langs }).catch(() => { /* non-fatal */ })
      setProfile(updated)
      setChildren(await listProfiles())
      setEditOpen(false)
      showSuccess('Profile saved! ✅')
    } catch (err) {
      showError(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }, [profile, editName, editAge, editMascot, editLangs, setProfile, showSuccess, showError])

  const toggleEditLang = useCallback((code: string) => {
    if (code === 'en') return // English always on
    setEditLangs(prev => prev.includes(code) ? prev.filter(l => l !== code) : [...prev, code])
  }, [])

  // ── Reset memory (interests, sessions, discoveries) within a window ─────

  const handleResetMemory = useCallback(async () => {
    if (!profile) return
    const days: number | null = resetWindow === 'all' ? null : Number(resetWindow)
    const label =
      resetWindow === '1'   ? "today's"
      : resetWindow === '7' ? "the last 7 days of"
      : resetWindow === '30' ? "the last 30 days of"
      : 'ALL of'
    const confirmed = window.confirm(
      `Reset ${label} memory for ${profile.name}? Interests, session summaries, and discoveries from this period will be erased. The child profile and stars/XP stay safe.`
    )
    if (!confirmed) return
    setIsResetting(true)
    try {
      const r = await resetMemoryForProfile(profile.id, days)
      showSuccess(`Memory reset — cleared ${r.interests} interests, ${r.summaries} sessions, ${r.objects} discoveries.`)
    } catch (err) {
      showError(`Failed to reset memory: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsResetting(false)
    }
  }, [profile, resetWindow, showSuccess, showError])

  // ── Delete a child ──────────────────────────────────────────────────────

  const handleDeleteChild = useCallback(async (child: ChildProfile) => {
    const confirmed = window.confirm(
      `Delete ${child.name}'s profile and all their discoveries? This cannot be undone.`
    )
    if (!confirmed) return
    try {
      const remaining = await deleteProfile(child.id)
      if (remaining.length === 0) {
        setProfile(null)
        navigate('/onboarding')
        return
      }
      setChildren(remaining)
      // If we deleted the active child, switch to the next remaining one
      if (child.id === profile?.id) {
        setProfile(remaining[0])
      }
      showSuccess(`${child.name}'s profile was deleted`)
    } catch (err) {
      showError(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [profile, setProfile, navigate, showSuccess, showError])

  // ─── Render ─────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeArea className="bg-lavender-50 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-lavender-300 border-t-lavender-600 rounded-full" />
      </SafeArea>
    )
  }

  return (
    <SafeArea className="bg-gradient-to-br from-lavender-50 to-white overflow-y-auto">
      <div className="flex flex-col flex-1 px-4 py-2 max-w-sm mx-auto w-full gap-4">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90"
            aria-label="Go back"
          >
            ←
          </button>
          <h1 className="text-2xl font-extrabold text-lavender-700">Parent Settings ⚙️</h1>
        </div>

        {/* Toasts */}
        {successMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-mint-100 border-2 border-mint-400 text-mint-800 px-4 py-3 rounded-2xl font-bold text-center"
          >
            {successMessage}
          </motion.div>
        )}
        {errorMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-50 border-2 border-red-300 text-red-700 px-4 py-3 rounded-2xl font-bold text-center"
          >
            {errorMessage}
          </motion.div>
        )}

        {/* Profile card now lives below as a collapsed "Edit" panel —
            removed the duplicate read-only summary here. */}

        {/* View Dashboard */}
        <button
          onClick={() => navigate('/parent-dashboard')}
          className="
            w-full py-4 font-extrabold text-white text-lg
            bg-gradient-to-r from-lavender-500 to-lavender-700
            rounded-3xl shadow-md active:scale-95
            flex items-center justify-center gap-2
          "
        >
          📊 View {profile?.name ? `${profile.name}'s` : 'Progress'} Dashboard
        </button>

        {/* Children — switch / add */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Children</p>
          <div className="flex flex-col gap-2">
            {children.map(child => {
              const isActive = child.id === profile?.id
              const emoji = child.mascotChoice === 'lion' ? '🦁' : child.mascotChoice === 'owl' ? '🦉' : '🐰'
              return (
                <div
                  key={child.id}
                  className={`
                    flex items-center gap-1 rounded-2xl border-2 transition-all
                    ${isActive ? 'bg-lavender-50 border-lavender-400' : 'bg-white border-gray-200'}
                  `}
                >
                  <button
                    onClick={() => void handleSwitchChild(child)}
                    className="flex items-center gap-3 px-3 py-2.5 flex-1 min-w-0 text-left active:scale-95"
                  >
                    <span className="text-2xl">{emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-extrabold text-gray-800 truncate">{child.name}</p>
                      <p className="text-xs text-gray-400 font-medium">
                        Age {child.age} · {child.preferredLanguages.join(', ').toUpperCase()}
                      </p>
                    </div>
                    {isActive
                      ? <span className="text-xs font-extrabold text-lavender-600 bg-lavender-100 px-2 py-1 rounded-full">Active</span>
                      : <span className="text-xs font-bold text-lavender-400">Switch →</span>}
                  </button>
                  <button
                    onClick={() => void handleDeleteChild(child)}
                    className="w-10 h-10 flex items-center justify-center text-lg text-red-400 active:scale-90 flex-shrink-0"
                    aria-label={`Delete ${child.name}`}
                  >
                    🗑
                  </button>
                </div>
              )
            })}
          </div>
          <button
            onClick={() => navigate('/onboarding?add=1')}
            className="
              w-full py-3 font-extrabold text-lavender-600
              bg-lavender-50 border-2 border-dashed border-lavender-300
              rounded-2xl active:scale-95
            "
          >
            ＋ Add another child
          </button>
        </div>

        {/* Edit active child — collapsed by default, opens on "Edit" click */}
        {profile && (
          <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-2xl flex-shrink-0">
                  {profile.mascotChoice === 'lion' ? '🦁' : profile.mascotChoice === 'owl' ? '🦉' : '🐰'}
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-gray-400 font-bold uppercase tracking-wider truncate">{profile.name}'s Profile</p>
                  <p className="text-xs text-gray-500 font-medium truncate">
                    Age {profile.age} · {profile.preferredLanguages.join(', ').toUpperCase()}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setEditOpen(o => !o)}
                className="text-sm font-extrabold text-lavender-600 bg-lavender-50 px-3 py-1.5 rounded-full active:scale-95 flex-shrink-0"
                aria-expanded={editOpen}
              >
                {editOpen ? 'Close' : 'Edit ✎'}
              </button>
            </div>

            {/* Name */}
            {editOpen && (<>

            <div>
              <label className="text-sm font-bold text-gray-600">Name</label>
              <input
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                maxLength={50}
                className="mt-1 w-full px-4 py-3 text-base font-semibold bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400"
              />
            </div>

            {/* Age stepper */}
            <div>
              <label className="text-sm font-bold text-gray-600">Age</label>
              <div className="mt-1 flex items-center gap-3">
                <button
                  onClick={() => setEditAge(a => Math.max(2, a - 1))}
                  disabled={editAge <= 2}
                  className="w-11 h-11 rounded-xl text-2xl font-extrabold bg-lavender-100 text-lavender-600 active:scale-90 disabled:opacity-30"
                  aria-label="Younger"
                >−</button>
                <span className="text-2xl font-extrabold text-lavender-700 w-12 text-center">{editAge}</span>
                <button
                  onClick={() => setEditAge(a => Math.min(15, a + 1))}
                  disabled={editAge >= 15}
                  className="w-11 h-11 rounded-xl text-2xl font-extrabold bg-lavender-100 text-lavender-600 active:scale-90 disabled:opacity-30"
                  aria-label="Older"
                >＋</button>
              </div>
            </div>

            {/* Mascot */}
            <div>
              <label className="text-sm font-bold text-gray-600">Buddy</label>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {([['lion', '🦁', 'Leo'], ['owl', '🦉', 'Ollie'], ['bunny', '🐰', 'Benny']] as const).map(([c, e, n]) => (
                  <button
                    key={c}
                    onClick={() => setEditMascot(c)}
                    className={`flex flex-col items-center gap-1 py-3 rounded-2xl border-2 active:scale-95 ${editMascot === c ? 'bg-lavender-100 border-lavender-400' : 'bg-white border-gray-200'}`}
                  >
                    <span className="text-3xl">{e}</span>
                    <span className="text-xs font-bold text-gray-600">{n}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Languages */}
            <div>
              <label className="text-sm font-bold text-gray-600">Languages</label>
              <div className="mt-1 flex flex-wrap gap-2">
                {([['en', 'English'], ['kn', 'Kannada'], ['hi', 'Hindi'], ['ta', 'Tamil'], ['te', 'Telugu']] as const).map(([c, l]) => {
                  const on = editLangs.includes(c)
                  return (
                    <button
                      key={c}
                      onClick={() => toggleEditLang(c)}
                      disabled={c === 'en'}
                      className={`px-3 py-2 rounded-full text-sm font-bold border-2 active:scale-95 ${on ? 'bg-mint-100 border-mint-400 text-mint-700' : 'bg-white border-gray-200 text-gray-400'} ${c === 'en' ? 'opacity-70 cursor-default' : ''}`}
                    >
                      {on ? '✓ ' : ''}{l}
                    </button>
                  )
                })}
              </div>
            </div>

            <button
              onClick={() => void handleSaveProfile()}
              disabled={isSaving}
              className="w-full py-3 font-bold text-white bg-gradient-to-r from-lavender-500 to-lavender-700 rounded-2xl disabled:opacity-50 active:scale-95"
            >
              {isSaving ? 'Saving...' : 'Save Profile'}
            </button>
            </>)}
          </div>
        )}

        {/* Gemini API Key */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Gemini API Key</p>

          {currentKeyMasked && (
            <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2">
              <span className="text-sm font-mono text-gray-500 flex-1 truncate">
                {showApiKey ? currentKeyMasked : '••••••••••••••••••••••••'}
              </span>
              <button
                onClick={() => setShowApiKey(p => !p)}
                className="text-xs text-lavender-500 font-bold"
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
          )}

          <input
            type="text"
            value={newApiKey}
            onChange={e => setNewApiKey(e.target.value)}
            placeholder="Paste new key (starts with AIza...)"
            className="
              w-full px-4 py-3 text-base font-mono
              bg-gray-50 border-2 border-gray-200 rounded-2xl
              focus:outline-none focus:border-lavender-400
              placeholder:text-gray-300 placeholder:font-sans placeholder:text-sm
            "
          />

          <button
            onClick={() => void handleUpdateApiKey()}
            disabled={!newApiKey.trim() || isSaving}
            className="
              w-full py-3 font-bold text-white
              bg-gradient-to-r from-lavender-500 to-lavender-700
              rounded-2xl disabled:opacity-50 active:scale-95
            "
          >
            {isSaving ? 'Saving...' : 'Update Key'}
          </button>
        </div>

        {/* AI Models */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">AI Models</p>
          <p className="text-sm text-gray-500 font-medium -mt-1">
            Advanced: pick which Gemini models power chat and the camera. Leave the defaults unless a model is retired or you want a newer one.
          </p>

          <button
            onClick={() => void handleLoadModels()}
            disabled={loadingModels}
            className="self-start text-sm font-bold text-lavender-600 underline underline-offset-2 disabled:opacity-50"
          >
            {loadingModels ? 'Loading…' : '↻ Load models my key supports'}
          </button>

          <datalist id="model-options">
            {availableModels.map(m => <option key={m} value={m} />)}
          </datalist>

          <label className="text-sm font-bold text-gray-600 flex flex-col gap-1">
            🧠 Reasoning model (chat &amp; words)
            <input
              list="model-options"
              value={chatModel}
              onChange={e => setChatModel(e.target.value)}
              placeholder={DEFAULT_CHAT_MODEL}
              className="px-4 py-2.5 text-sm font-mono bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400"
            />
          </label>

          <label className="text-sm font-bold text-gray-600 flex flex-col gap-1">
            📷 Vision model (camera)
            <input
              list="model-options"
              value={visionModel}
              onChange={e => setVisionModel(e.target.value)}
              placeholder={DEFAULT_VISION_MODEL}
              className="px-4 py-2.5 text-sm font-mono bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400"
            />
          </label>

          {availableModels.length > 0 && (
            <p className="text-xs text-gray-400 font-medium">
              {availableModels.length} models available — start typing to autocomplete.
            </p>
          )}

          <button
            onClick={() => void handleSaveModels()}
            disabled={isSaving}
            className="
              w-full py-3 font-bold text-white
              bg-gradient-to-r from-lavender-500 to-lavender-700
              rounded-2xl disabled:opacity-50 active:scale-95
            "
          >
            {isSaving ? 'Saving...' : 'Save Models'}
          </button>
        </div>

        {/* Session time limit */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">
            Session Time Limit
          </p>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={10}
              max={60}
              step={5}
              value={sessionLimit}
              onChange={e => setSessionLimit(Number(e.target.value))}
              className="flex-1 accent-lavender-500"
            />
            <span className="text-lg font-extrabold text-lavender-700 w-16 text-right">
              {sessionLimit} min
            </span>
          </div>
          <button
            onClick={() => void handleUpdateSessionLimit()}
            disabled={isSaving}
            className="
              w-full py-3 font-bold text-white
              bg-gradient-to-r from-mint-500 to-mint-600
              rounded-2xl disabled:opacity-50 active:scale-95
            "
          >
            Save Limit
          </button>
        </div>

        {/* Sound effects toggle */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Sound Effects</p>
            <p className="text-sm text-gray-500 font-medium mt-0.5">
              Taps, chimes &amp; celebrations
            </p>
          </div>
          <button
            role="switch"
            aria-checked={soundOn}
            aria-label="Toggle sound effects"
            onClick={() => {
              const next = !soundOn
              setSoundOn(next)
              setSfxMuted(!next)
              if (next) playSuccess()
            }}
            className={`
              relative w-14 h-8 rounded-full transition-colors flex-shrink-0
              ${soundOn ? 'bg-mint-500' : 'bg-gray-300'}
            `}
          >
            <span
              className={`
                absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all
                ${soundOn ? 'left-7' : 'left-1'}
              `}
            />
          </button>
        </div>

        {/* Leo's Voice */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Leo's Voice</p>
          <p className="text-sm text-gray-500 font-medium -mt-1">
            Pick the most natural-sounding voice on this device. Tip: Chrome &amp; Edge offer "Google" / "Natural" voices that sound far more human than the default.
          </p>
          {voices.length === 0 ? (
            <p className="text-sm text-gray-400 font-medium">
              No voices found for this language on this device yet. Try Chrome on Android or Safari on iOS.
            </p>
          ) : (
            <>
              <select
                value={selectedVoiceURI}
                onChange={e => handleSelectVoice(e.target.value)}
                className="w-full px-4 py-3 text-sm font-semibold bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400"
              >
                <option value="">Auto — best available ({voices[0]?.name})</option>
                {voices.map(v => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              <button
                onClick={handlePreviewVoice}
                className="w-full py-3 font-bold text-lavender-700 bg-lavender-50 border-2 border-lavender-200 rounded-2xl active:scale-95"
              >
                🔊 Preview voice
              </button>
            </>
          )}
        </div>

        {/* Camera toggle */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Camera</p>
            <p className="text-sm text-gray-500 font-medium mt-0.5">"What Is This?" photo mode</p>
          </div>
          <button
            role="switch"
            aria-checked={cameraEnabled}
            aria-label="Toggle camera"
            onClick={() => void handleToggleCamera()}
            className={`relative w-14 h-8 rounded-full transition-colors flex-shrink-0 ${cameraEnabled ? 'bg-mint-500' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all ${cameraEnabled ? 'left-7' : 'left-1'}`} />
          </button>
        </div>

        {/* Parent PIN */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Parent PIN</p>
            {hasPin && <span className="text-xs font-bold text-mint-600 bg-mint-50 px-2 py-0.5 rounded-full">On 🔒</span>}
          </div>
          <p className="text-sm text-gray-500 font-medium -mt-1">
            Locks Settings &amp; the Dashboard so little hands can't change things.
          </p>
          {hasPin ? (
            <button
              onClick={() => void handleRemovePin()}
              disabled={isSaving}
              className="w-full py-3 font-bold text-red-600 bg-white border-2 border-red-300 rounded-2xl active:scale-95 disabled:opacity-50"
            >
              Remove PIN
            </button>
          ) : (
            <>
              <input
                inputMode="numeric"
                maxLength={4}
                value={pinInput}
                onChange={e => setPinInput(e.target.value.replace(/\D/g, ''))}
                placeholder="New 4-digit PIN"
                className="w-full px-4 py-3 text-lg font-mono tracking-[0.4em] text-center bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400 placeholder:tracking-normal placeholder:font-sans placeholder:text-sm placeholder:text-gray-300"
              />
              <input
                inputMode="numeric"
                maxLength={4}
                value={pinConfirm}
                onChange={e => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                placeholder="Confirm PIN"
                className="w-full px-4 py-3 text-lg font-mono tracking-[0.4em] text-center bg-gray-50 border-2 border-gray-200 rounded-2xl focus:outline-none focus:border-lavender-400 placeholder:tracking-normal placeholder:font-sans placeholder:text-sm placeholder:text-gray-300"
              />
              <button
                onClick={() => void handleSetPin()}
                disabled={isSaving || pinInput.length !== 4}
                className="w-full py-3 font-bold text-white bg-gradient-to-r from-lavender-500 to-lavender-700 rounded-2xl disabled:opacity-50 active:scale-95"
              >
                Set PIN
              </button>
            </>
          )}
        </div>

        {/* Drive sync */}
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
          <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Google Drive Backup</p>
          {settings?.lastSyncedAt && (
            <p className="text-sm text-gray-400">
              Last synced: {new Date(settings.lastSyncedAt).toLocaleDateString()}
            </p>
          )}
          {!googleToken && (
            <p className="text-sm text-gray-500 font-medium -mt-1">
              You'll be asked to connect Google once, then it backs up instantly.
            </p>
          )}
          <button
            onClick={() => handleDriveSync()}
            disabled={syncStatus === 'syncing'}
            className="
              w-full py-3 font-bold text-white
              bg-gradient-to-r from-sky-400 to-sky-600
              rounded-2xl disabled:opacity-50 active:scale-95
              flex items-center justify-center gap-2
            "
          >
            {syncStatus === 'syncing' ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {googleToken ? 'Syncing...' : 'Connecting...'}
              </>
            ) : syncStatus === 'done' ? (
              '✅ Synced!'
            ) : googleToken ? (
              '☁️ Sync Now'
            ) : (
              '☁️ Connect & Back Up'
            )}
          </button>
        </div>

        {/* Reset memory (interests, sessions, discoveries) within a time window */}
        {profile && (
          <div className="bg-white rounded-3xl p-4 shadow-sm border border-lavender-100 flex flex-col gap-3">
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Reset Memory</p>
            <p className="text-sm text-gray-500 font-medium -mt-1">
              Clears {profile.name}'s interests, session summaries and discoveries from the chosen window. The profile and stars/XP stay safe.
            </p>
            <div className="grid grid-cols-4 gap-2">
              {([
                ['1',   'Today'],
                ['7',   '7 days'],
                ['30',  '30 days'],
                ['all', 'All time'],
              ] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setResetWindow(val)}
                  className={`py-2 rounded-2xl text-sm font-extrabold border-2 active:scale-95 ${resetWindow === val ? 'bg-lavender-100 border-lavender-400 text-lavender-700' : 'bg-white border-gray-200 text-gray-500'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void handleResetMemory()}
              disabled={isResetting}
              className="w-full py-3 font-bold text-white bg-gradient-to-r from-coral-400 to-coral-600 rounded-2xl disabled:opacity-50 active:scale-95"
            >
              {isResetting ? 'Resetting...' : '🧹 Reset Memory'}
            </button>
          </div>
        )}

        {/* Danger zone */}
        {profile && (
          <div className="bg-red-50 rounded-3xl p-4 border border-red-200 flex flex-col gap-3">
            <p className="text-xs text-red-500 font-bold uppercase tracking-wider">Danger Zone</p>
            <p className="text-sm text-gray-500 font-medium -mt-1">
              Deletes {profile.name}'s profile and all their discoveries. {children.length <= 1 ? 'This is the last child, so the app resets to setup.' : 'Other children are kept.'}
            </p>
            <button
              onClick={() => void handleDeleteChild(profile)}
              className="
                w-full py-3 font-bold text-red-600
                bg-white border-2 border-red-300
                rounded-2xl active:scale-95
              "
            >
              🗑️ Delete {profile.name}'s Profile
            </button>
          </div>
        )}

      </div>
    </SafeArea>
  )
}
