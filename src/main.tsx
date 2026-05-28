import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import App from './App'
import { installGlobalErrorCapture } from './lib/debugLog'
import { applyTheme, getThemeMode } from './lib/theme'
import { primeSpeechOnGesture } from './lib/voice'
import './index.css'

// Capture uncaught errors / rejections / console.error|warn into the in-app
// debug log BEFORE React mounts, so even early crashes are recorded.
installGlobalErrorCapture()

// Apply the saved theme mode before mount so the kid never sees a dark flash.
applyTheme(getThemeMode())

// iOS/some mobile browsers silently block TTS until a user gesture happens.
// This hook unlocks speechSynthesis on the very first tap so Leo's greeting
// and chat responses become audible.
primeSpeechOnGesture()

// Set VITE_GOOGLE_CLIENT_ID in your .env file
// See .env.example for the format
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
if (!clientId) {
  document.body.innerHTML = `<div style="font-family:sans-serif;padding:40px;text-align:center;background:#FDE8FF;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column"><h2>⚙️ Setup Required</h2><p>Copy <code>.env.example</code> to <code>.env</code> and set your <code>VITE_GOOGLE_CLIENT_ID</code>.</p><p>See README.md for instructions.</p></div>`
  throw new Error('VITE_GOOGLE_CLIENT_ID is not set. Copy .env.example to .env.')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={clientId}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </GoogleOAuthProvider>
  </React.StrictMode>
)
