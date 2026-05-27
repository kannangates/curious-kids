# CuriousKids AI 🦁

A zero-cost, voice-first educational PWA for young children. Leo the mascot chats, teaches, translates, and plays — powered by Google Gemini Flash and running entirely in the browser with **no backend**.

> Designed for ages 4+ — the AI adapts its vocabulary and depth to each child's saved age.

## Features

**Learning & play**
- Voice-first conversation with a mascot — choose **Leo 🦁 / Ollie 🦉 / Benny 🐰**, each with its own personality
- 📷 **Camera mode** ("What Is This?") — Gemini Vision identifies objects, with a fun fact, translations, and a mini-quiz
- 📚 **Word Explorer** — voice translation into the child's languages
- 🎮 **Word Match** game — match words to translations, earn XP
- 🧩 **Puzzle Mode** — AI riddles about the child's own discoveries
- 🌙 **Bedtime Story Mode** — a personalised story read aloud in a slow, calm voice
- ⭐ **My Discoveries** gallery + **XP and 4 levels** (Explorer → Adventurer → Scholar → Champion) with celebrations

**Personalisation & memory**
- Multilingual: English, Kannada, Hindi, Tamil, Telugu
- Local interest tracking, daily session summaries, and a "yesterday you learned…" greeting
- Parent-selectable **TTS voice** (with preview) and **Gemini model** for chat & vision

**Parent controls** (in Settings, behind an optional PIN)
- **Multi-child profiles** — add, switch, edit (name/age/buddy/languages), and delete children
- Optional **4-digit Parent PIN** lock on Settings & Dashboard
- **Daily time limit** with a gentle "time's up" screen
- Camera on/off, sound effects on/off
- **Parent Dashboard** — XP, top interests, recent sessions, and a **Weekly Report**

**Platform**
- PWA — installable, works offline with warm fallback responses
- Google Sign-In for the parent; Google Drive (`appDataFolder`) backup, one file per child
- Free voice via the Web Speech API (STT + TTS) — no voice API cost

## Setup

### Prerequisites
- Node.js 20+
- A Google account, a free [Gemini API key](https://aistudio.google.com/app/apikey), and a [Google OAuth Client ID](https://console.cloud.google.com/apis/credentials)

### Steps
1. **Install**
   ```bash
   npm install
   ```
2. **Configure** — copy `.env.example` to `.env` and set your client ID:
   ```
   VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```
   In the Google Cloud Console for that OAuth client:
   - Add **Authorized JavaScript origins**: `http://localhost:5173` and `http://localhost:4173` (plus your production URL).
   - Enable the **Google Drive API**, add the `drive.appdata` scope to the consent screen, and (while the app is in "Testing") add your account under **Test users**.
   > Vite inlines the client ID at build time — changing `.env` requires restarting `npm run dev` / rebuilding.
3. **Run**
   ```bash
   npm run dev      # http://localhost:5173
   ```
4. **First launch** — sign in with Google → enter the child's name & age → paste your Gemini API key (validated live) → pick languages → choose a mascot.

### Build for production
```bash
npm run build      # tsc + vite build (code-split, PWA service worker)
npm run preview    # serve the production build on :4173
```

> `npm run lint` is currently a no-op — no ESLint config is set up. `tsc` (run by `npm run build`) is the type/correctness gate.

## How it works

- **Local-first, no server.** The parent supplies their own Gemini key; all child data is in IndexedDB. Google Drive is used only as per-child backup.
- **API key encryption.** The Gemini key is AES-GCM encrypted using a key derived from the parent's Google `sub` (PBKDF2/WebCrypto) — never stored in plaintext. The `sub` is cached locally so refreshes don't force a re-login; the Drive access token is short-lived and reconnected on demand from Settings → "Connect & Back Up".
- **Time/date** questions are answered from the device clock (LLMs have no clock), instantly and offline.
- **Safety.** Input/output blocklists layer on top of Gemini's safety settings. Camera frames are analysed in-memory and **never stored** (the stream is released before the network call).

```
src/
  db/         — Dexie IndexedDB schema (childProfiles, interestTags, sessionSummaries, learnedObjects, appSettings)
  store/      — Zustand global state (auth, profile, session)
  lib/        — crypto, gemini, geminiClient, voice, safety, drive, session, memory,
                xp, usage, profiles, audio, localAnswers
  prompts/    — Gemini prompt builders (system, translation, camera, bedtime, puzzle, weekly report)
  hooks/      — useSpeech, useSessionLimit
  components/ — LeoMascot, VoiceButton, SafeArea, XPCelebration, TimeUpScreen, WelcomeBackScreen, ParentGate
  screens/    — Onboarding, Home, Chat, Camera, WordExplorer, WordGame, Puzzle, Discoveries,
                BedtimeStory, ParentSettings, ParentDashboard
```

See `CLAUDE.md` for the deeper architecture (auth/crypto chain, route guards, IndexedDB-vs-localStorage split, multi-child model) and `curious-kids-prd.html` for the full living spec.

## Privacy
- Gemini API key: encrypted (AES-GCM-256) with the Google `sub` as key material; only the ciphertext is stored/synced.
- All child data stays in IndexedDB on the device; Drive sync uses the app-private `appDataFolder`.
- Camera images are discarded immediately after analysis; no third-party analytics or tracking.

## License
MIT
