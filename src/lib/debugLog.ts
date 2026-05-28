// Lightweight in-app debug log: captures uncaught errors, unhandled promise
// rejections, console.error / console.warn, plus manual breadcrumbs.
// Surfaced via <DebugOverlay /> so users on mobile (where DevTools is hard)
// can see and copy a real error trail.

export type Level = 'error' | 'warn' | 'info'

export interface LogEntry {
  id: number
  t: number          // ms since epoch
  level: Level
  message: string
  detail?: string    // stringified stack / object
}

const MAX_ENTRIES = 200
const MAX_PERSIST_DAYS = 7
const DAY_KEY_PREFIX = 'ck_log_'
const DEBUG_FLAG_KEY = 'ck_debug_enabled'

let buf: LogEntry[] = []
let nextId = 1
const subs = new Set<() => void>()
const debugSubs = new Set<() => void>()

// ─── Debug-mode enable flag (parent-controlled in Settings) ────────────────

export function isDebugEnabled(): boolean {
  try { return localStorage.getItem(DEBUG_FLAG_KEY) === '1' } catch { return false }
}

export function setDebugEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEBUG_FLAG_KEY, '1')
    else localStorage.removeItem(DEBUG_FLAG_KEY)
  } catch { /* ignore */ }
  debugSubs.forEach(s => { try { s() } catch { /* ignore */ } })
  // Boot breadcrumb so the parent sees the toggle event in the log
  logEvent('info', `Debug mode ${on ? 'ENABLED' : 'disabled'}`)
}

export function subscribeDebugFlag(cb: () => void): () => void {
  debugSubs.add(cb)
  return () => { debugSubs.delete(cb) }
}

/**
 * Logs a user-action breadcrumb. Silent when debug is OFF — errors / warns
 * still come through their own paths (console.* and global handlers) so a
 * crash report is captured regardless of this flag.
 */
export function logAction(message: string, detail?: unknown): void {
  if (!isDebugEnabled()) return
  logEvent('info', message, detail)
}

// ─── Per-day localStorage persistence ──────────────────────────────────────

function todayDateString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function appendToTodayStorage(entry: LogEntry): void {
  try {
    const key = DAY_KEY_PREFIX + todayDateString()
    const existing = localStorage.getItem(key)
    const arr = existing ? (JSON.parse(existing) as LogEntry[]) : []
    arr.push(entry)
    // Cap per-day size so localStorage can't blow up
    if (arr.length > MAX_ENTRIES * 5) arr.splice(0, arr.length - MAX_ENTRIES * 5)
    localStorage.setItem(key, JSON.stringify(arr))
  } catch { /* quota / private mode — ignore */ }
}

function pruneOldDays(): void {
  try {
    const cutoffMs = Date.now() - MAX_PERSIST_DAYS * 24 * 60 * 60 * 1000
    const keysToDelete: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(DAY_KEY_PREFIX)) continue
      const date = k.slice(DAY_KEY_PREFIX.length)
      const t = Date.parse(date)
      if (Number.isFinite(t) && t < cutoffMs) keysToDelete.push(k)
    }
    keysToDelete.forEach(k => localStorage.removeItem(k))
  } catch { /* ignore */ }
}

interface StoredDay { date: string; entries: LogEntry[] }

export function getAllStoredLogs(): StoredDay[] {
  const days: StoredDay[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(DAY_KEY_PREFIX)) continue
      try {
        const entries = JSON.parse(localStorage.getItem(k) || '[]') as LogEntry[]
        if (Array.isArray(entries) && entries.length > 0) {
          days.push({ date: k.slice(DAY_KEY_PREFIX.length), entries })
        }
      } catch { /* ignore single-day parse failures */ }
    }
    days.sort((a, b) => a.date.localeCompare(b.date))
  } catch { /* ignore */ }
  return days
}

function notify(): void {
  subs.forEach(s => { try { s() } catch { /* ignore */ } })
}

function safeStringify(v: unknown): string {
  try {
    if (v == null) return ''
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
    if (typeof v === 'string') return v
    return JSON.stringify(v, Object.getOwnPropertyNames(v as object).concat(Object.keys(v as object)), 2)
  } catch {
    return String(v)
  }
}

export function logEvent(level: Level, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    id: nextId++,
    t: Date.now(),
    level,
    message: String(message).slice(0, 500),
    detail: detail === undefined ? undefined : safeStringify(detail).slice(0, 1500),
  }
  buf.push(entry)
  if (buf.length > MAX_ENTRIES) buf = buf.slice(-MAX_ENTRIES)
  appendToTodayStorage(entry)  // persist for cross-session daily file export
  notify()
}

export function getLog(): LogEntry[] {
  return buf
}

export function clearLog(): void {
  buf = []
  notify()
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** Snapshot for useSyncExternalStore — same reference between renders unless mutated. */
export function getLogSnapshot(): LogEntry[] {
  return buf
}

// ─── Global capture ─────────────────────────────────────────────────────────

let installed = false

export function installGlobalErrorCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  pruneOldDays() // drop log files older than MAX_PERSIST_DAYS

  window.addEventListener('error', (e) => {
    logEvent('error', e.message || 'window error', e.error ?? `${e.filename}:${e.lineno}:${e.colno}`)
  })

  window.addEventListener('unhandledrejection', (e) => {
    logEvent('error', 'Unhandled promise rejection', e.reason)
  })

  const origErr = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ')
      logEvent('error', msg.slice(0, 600))
    } catch { /* ignore */ }
    origErr(...args)
  }

  const origWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ')
      logEvent('warn', msg.slice(0, 600))
    } catch { /* ignore */ }
    origWarn(...args)
  }

  // Tiny boot breadcrumb so we know capture is live
  logEvent('info', 'Debug log capturing started', {
    ua: navigator.userAgent,
    online: navigator.onLine,
    url: window.location.href,
  })
}

function formatEntry(e: LogEntry): string {
  const head = `[${new Date(e.t).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`
  return e.detail ? `${head}\n  ${e.detail.replace(/\n/g, '\n  ')}` : head
}

/** Format the in-memory (current session) log as a copy-friendly multiline string. */
export function formatLogForCopy(): string {
  return buf.map(formatEntry).join('\n')
}

/**
 * Format ALL persisted daily logs (up to MAX_PERSIST_DAYS) as a single text
 * file. Each day is separated by a header so the file is easy to scan.
 * Used by the Save / Share button — works offline, no upload required.
 */
export function formatAllStoredLogs(): string {
  const days = getAllStoredLogs()
  if (days.length === 0) return formatLogForCopy() // nothing persisted yet
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const header =
    `CuriousKids — debug log\n` +
    `Exported: ${new Date().toISOString()}\n` +
    `User-Agent: ${ua}\n` +
    `Days included: ${days.map(d => d.date).join(', ')}\n` +
    `${'═'.repeat(60)}\n`
  return header + days.map(d => {
    const dayHeader = `\n──── ${d.date}  (${d.entries.length} entries) ────`
    return dayHeader + '\n' + d.entries.map(formatEntry).join('\n')
  }).join('\n')
}

/** Suggested filename for the export, dated today. */
export function suggestedLogFilename(): string {
  return `curious-kids-log-${todayDateString()}.txt`
}
