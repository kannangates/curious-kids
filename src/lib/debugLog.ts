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
let buf: LogEntry[] = []
let nextId = 1
const subs = new Set<() => void>()

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

/** Format the whole log as a copy-friendly multiline string. */
export function formatLogForCopy(): string {
  return buf.map(e => {
    const head = `[${new Date(e.t).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`
    return e.detail ? `${head}\n  ${e.detail.replace(/\n/g, '\n  ')}` : head
  }).join('\n')
}
