# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server at http://localhost:5173 (HMR).
- `npm run build` — `tsc && vite build`. **`tsc --noEmit` is the real correctness gate** — run it after changes (`npx tsc --noEmit`).
- `npm run preview` — serve the production build (port 4173); used for Lighthouse.
- `npm run lint` — **currently broken**: there is no ESLint config file, so this fails with "couldn't find a configuration file". Rely on `tsc` instead.
- There is **no test suite** (no test runner configured).

Requires Node 20+. Needs a `.env` with `VITE_GOOGLE_CLIENT_ID=...apps.googleusercontent.com` (Vite inlines it at build time, so changing it requires a rebuild/restart). `localhost:5173` and `:4173` must be Authorized JavaScript Origins on the OAuth client, and the signed-in account must be a Test User on the OAuth consent screen.

## Routes / screens

`/onboarding` (no guard) · `/` Home · `/chat` · `/camera` · `/words` (Word Explorer) · `/wordgame` (Word Match) · `/puzzle` · `/discoveries` · `/bedtime` — all child-play (time-guarded). `/settings` and `/parent-dashboard` are parent routes (PIN-guarded, not time-guarded).

## Big picture

A **zero-backend, local-first PWA**. Everything runs in the browser: the parent supplies their own Gemini API key, data lives in IndexedDB, and Google Drive (`appDataFolder` scope) is the only remote — used purely as per-child backup. There is no server to deploy beyond static hosting. Voice (STT/TTS) uses the free Web Speech API.

### Auth + crypto chain (read `crypto.ts`, `store/app.ts`, `App.tsx`, `WelcomeBackScreen.tsx` together)
- Google Sign-In uses `useGoogleLogin({ flow: 'implicit' })` → an **access token** (for Drive) plus the user's **`sub`** (fetched from the userinfo endpoint).
- The Gemini API key is **AES-GCM encrypted with a key derived from the Google `sub`** (PBKDF2, salt `curiouskie-v1`). It is never stored in plaintext; the ciphertext lives in IndexedDB and syncs to Drive.
- The `sub` is the decryption key material. It is persisted in `localStorage` (`ck_google_sub`) and restored into the store on load so refreshes don't force re-login. The Drive **access token is NOT persisted** (expires ~1h) — Drive sync therefore requires an interactive connect (the Settings "Sync Now" button triggers `useGoogleLogin` on demand).
- `WelcomeBackScreen` is the fallback gate shown only when there is no `sub` at all (new device / cleared data), not on normal refreshes.

### Route guards (all in `App.tsx`)
Three nested wrappers, applied per route:
- `RequireAuth` — redirects to `/onboarding` if no child profile exists; also shows `WelcomeBackScreen` when a profile exists but `sub` is missing.
- `TimeGuard` — wraps **child-play routes only** (`/`, `/chat`, `/camera`, `/words`, `/discoveries`, `/bedtime`, `/wordgame`, `/puzzle`); swaps in `TimeUpScreen` when the daily limit is hit.
- `ParentGate` — wraps `/settings` and `/parent-dashboard` (NOT time-guarded, so the limit can always be changed); shows a PIN keypad if `parentPinHash` is set. Unlock is remembered for the session via a module-level flag.
- Screens are **lazy-loaded** via `React.lazy`; named exports are mapped to default in the `lazy()` import. `HomeScreen`/`OnboardingScreen` stay eager.

### Gemini client (`lib/gemini.ts` + `lib/geminiClient.ts`)
- `createGeminiClient(apiKey, { chatModel, visionModel })` — models are parent-configurable (stored on `appSettings`, default `gemini-2.0-flash`). Chat uses `temperature: 1.0` for variety; vision uses `0.4` for reliable JSON.
- `loadGeminiClient(googleSub)` is the shared helper screens use: it reads `appSettings`, decrypts the key with the `sub`, and applies the configured models.
- **Error classification matters**: the SDK wraps every HTTP error in a message containing the word "fetch", so do NOT treat that as offline. `isOfflineError` only matches genuine connectivity failures; `API_KEY_INVALID` → `ApiKeyError`; otherwise the real status is surfaced. The streaming loop guards `chunk.text()` (it can throw on RECITATION/empty chunks).

### Storage split — IndexedDB vs localStorage (important)
Dexie (`db/index.ts`) holds the canonical data: `childProfiles`, `interestTags`, `sessionSummaries`, `learnedObjects`, `appSettings` (singleton `id:'main'`). **Adding a non-indexed field to a table needs NO version bump** (that's how `chatModel`/`visionModel` were added).

Several things deliberately live in `localStorage` to avoid schema migrations and for synchronous access:
- `ck_xp_<profileId>` — XP totals (`lib/xp.ts`)
- `ck_usage_<profileId>_<dateString>` — daily usage minutes for the time limit (`lib/usage.ts`)
- `ck_camera_consent_<profileId>` — camera consent
- `ck_active_profile_id` — active child (`lib/profiles.ts`)
- `ck_google_sub` — persisted Google sub (`store/app.ts`)
- `ck_voice_uri` — parent-chosen TTS voice (`lib/voice.ts`)
- `ck_sfx_muted`, `ck_cam_migrated` — flags
`lib/profiles.ts#deleteProfile` is the single place that tears all of this down per child (and wipes `appSettings` only when the last child is removed). Use it rather than deleting rows ad-hoc.

### Multi-child model
All children belong to one signed-in Google account and **share the single encrypted API key**. Each child is a separate profile row and a separate Drive file (`curiouskie-<childName>.json`). Switching child only changes the store's `profile`. "Add another child" re-enters onboarding via `/onboarding?add=1`, which skips sign-in and the API-key step.

### Voice pipeline (`lib/voice.ts`, `hooks/useSpeech.ts`)
- `selectVoice` **scores** voices for naturalness (big bonus for Natural/Neural/Online/Google, penalty for Desktop/eSpeak) and honors the parent-chosen `ck_voice_uri`. This is the main lever for "human-sounding" output. `speak()` must set `utterance.voice` *before* `speechSynthesis.speak()`, deferring until `voiceschanged` if voices aren't loaded yet.
- `ChatScreen` streams Gemini and speaks **sentence-by-sentence** as chunks arrive (buffer flushed on `.!?` or >200 chars).
- Time/date questions are answered locally via `lib/localAnswers.ts` **before** hitting the AI (LLMs have no clock); checked in `ChatScreen.handleUserMessage`.

### Safety
`lib/safety.ts` is a conservative input/output blocklist (`checkInput`/`checkOutput`), layered on top of Gemini's `safetySettings`. Unsafe input → `SAFE_DEFLECTION`. Camera frames are captured to canvas, the stream is released **before** the network call, and the base64 is discarded after analysis — never stored.

## Conventions
- Tailwind only (kid palette: `leo`/`lavender`/`coral`/`mint`/`sky`); chunky buttons, Framer Motion, big emoji.
- Async effects in screens use an `isMountedRef`/`cancelled` guard before `set*` calls (these screens unmount mid-stream often).
- All DB writes that could hit quota go through `safeDbWrite`.
- The PRD (`curious-kids-prd.html`) is a standalone living-spec document; its top "Status Snapshot" + `✓ Built` badges track what's actually implemented.
