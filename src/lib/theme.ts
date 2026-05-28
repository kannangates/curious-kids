// App theme: defaults to LIGHT so the kid never sees a dark UI even if the
// device's system theme is dark. Parent can flip to "Follow system" in
// Settings — that's the only opt-out. (We don't ship a designed dark mode
// yet; this just controls the browser's color-scheme behavior.)

export type ThemeMode = 'light' | 'system'

const KEY = 'ck_theme_mode'

export function getThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(KEY) === 'system' ? 'system' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('theme-system', mode === 'system')
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') localStorage.setItem(KEY, 'system')
    else localStorage.removeItem(KEY)
  } catch { /* ignore */ }
  applyTheme(mode)
}
