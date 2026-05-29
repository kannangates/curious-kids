// Shared language types + display helpers. Kept tiny so every screen can
// import from one place without dragging in unrelated dependencies.

export type AppLang = 'en' | 'kn' | 'hi' | 'ta' | 'te'

export const APP_LANGS: readonly AppLang[] = ['en', 'kn', 'hi', 'ta', 'te'] as const

/** Human-readable language name for prompts + parent UI. */
export const LANG_NAME: Record<AppLang, string> = {
  en: 'English',
  kn: 'Kannada',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
}

/** Quick type-guard so untrusted string can be narrowed to AppLang. */
export function isAppLang(v: unknown): v is AppLang {
  return typeof v === 'string' && (APP_LANGS as readonly string[]).includes(v)
}
