import { useState, useSyncExternalStore } from 'react'
import {
  subscribe,
  getLogSnapshot,
  clearLog,
  formatLogForCopy,
  formatAllStoredLogs,
  suggestedLogFilename,
  isDebugEnabled,
  subscribeDebugFlag,
  type LogEntry,
} from '../lib/debugLog'

function useDebugFlag(): boolean {
  return useSyncExternalStore(subscribeDebugFlag, isDebugEnabled, isDebugEnabled)
}

/**
 * Save the full stored log (up to 7 days) as a .txt. Uses the Web Share API
 * with a File when available — that's the one-tap way on mobile to send the
 * log via WhatsApp/Email/Files/AirDrop. Falls back to a regular download.
 */
async function shareOrDownloadLog(): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const text = formatAllStoredLogs()
  const filename = suggestedLogFilename()

  // 1) Web Share with a File (modern mobile)
  try {
    const file = new File([text], filename, { type: 'text/plain' })
    const navAny = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean }
    if (navAny.canShare && navAny.canShare({ files: [file] }) && typeof navigator.share === 'function') {
      await navigator.share({ files: [file], title: 'CuriousKids debug log' })
      return 'shared'
    }
  } catch (err) {
    // User cancelled, or share failed → fall through to download
    if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
  }

  // 2) Fallback: trigger a normal browser download
  try {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return 'downloaded'
  } catch {
    return 'cancelled'
  }
}

function useLog(): LogEntry[] {
  return useSyncExternalStore(subscribe, getLogSnapshot, getLogSnapshot)
}

/**
 * Floating 🐞 button + panel. Visible only when there is at least one log
 * entry (info / warn / error). Tap to open a full-screen-ish panel with the
 * captured entries; Copy puts the whole log on the clipboard.
 *
 * Lives outside <Routes> so it appears on every screen, including failure
 * states like the login loop.
 */
export function DebugOverlay() {
  const debugOn = useDebugFlag()
  const log = useLog()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedLabel, setSavedLabel] = useState<'' | '✓ Shared' | '✓ Downloaded'>('')

  // Only show the floating overlay when the parent has turned debug on.
  // (Errors are still captured silently in the background regardless.)
  if (!debugOn) return null

  const errCount = log.filter(e => e.level === 'error').length
  const warnCount = log.filter(e => e.level === 'warn').length

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatLogForCopy())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const handleSave = async () => {
    const result = await shareOrDownloadLog()
    if (result === 'shared') setSavedLabel('✓ Shared')
    else if (result === 'downloaded') setSavedLabel('✓ Downloaded')
    setTimeout(() => setSavedLabel(''), 1800)
  }

  const badgeText =
    errCount > 0 ? `${errCount} err`
    : warnCount > 0 ? `${warnCount} warn`
    : `${log.length}`
  const badgeColor =
    errCount > 0 ? 'bg-red-600'
    : warnCount > 0 ? 'bg-yellow-500'
    : 'bg-lavender-600'

  return (
    <>
      {/* Floating button — bottom-left so it doesn't collide with FABs on the right */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`fixed left-3 bottom-3 z-[1000] px-3 py-1.5 rounded-full text-xs font-extrabold text-white shadow-lg active:scale-95 ${badgeColor}`}
        aria-label="Open debug log"
      >
        🐞 {badgeText}
      </button>

      {open && (
        <div
          className="
            fixed inset-x-3 bottom-16 z-[1000]
            max-h-[70vh] overflow-y-auto
            bg-black/90 text-white text-xs font-mono
            rounded-2xl p-3 shadow-2xl backdrop-blur-sm
          "
        >
          <div className="flex items-center justify-between mb-2 sticky top-0 bg-black/90 py-1 -mx-3 px-3">
            <span className="font-bold text-sm">
              Debug log <span className="opacity-60">({log.length})</span>
            </span>
            <div className="flex gap-1.5 flex-wrap justify-end">
              <button
                onClick={() => void handleSave()}
                className="px-2 py-1 bg-lavender-600 rounded text-xs font-bold"
                title="Save / Share log file"
              >
                {savedLabel || '📤 Save'}
              </button>
              <button
                onClick={() => void handleCopy()}
                className="px-2 py-1 bg-white/10 rounded text-xs"
              >
                {copied ? '✓' : 'Copy'}
              </button>
              <button
                onClick={() => clearLog()}
                className="px-2 py-1 bg-white/10 rounded text-xs"
              >
                Clear
              </button>
              <button
                onClick={() => setOpen(false)}
                className="px-2 py-1 bg-white/10 rounded text-xs"
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>

          {log.length === 0 ? (
            <p className="opacity-60 py-4 text-center">No events captured yet.</p>
          ) : (
            log.slice().reverse().map(e => {
              const color =
                e.level === 'error' ? 'text-red-300'
                : e.level === 'warn' ? 'text-yellow-300'
                : 'text-white/80'
              return (
                <div key={e.id} className={`mb-2 ${color}`}>
                  <div className="opacity-60">
                    {new Date(e.t).toLocaleTimeString()} · {e.level.toUpperCase()}
                  </div>
                  <div className="break-words">{e.message}</div>
                  {e.detail && (
                    <pre className="whitespace-pre-wrap opacity-70 mt-0.5">{e.detail}</pre>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </>
  )
}
