import type { ReactNode } from 'react'

interface SafeAreaProps {
  children: ReactNode
  className?: string
  /** Skip top safe-area padding (e.g. for screens with custom headers) */
  skipTop?: boolean
  /** Skip bottom safe-area padding */
  skipBottom?: boolean
}

/**
 * Wraps children with safe-area padding to handle notches, home indicators,
 * and status bars on PWA installs and mobile browsers.
 * Uses CSS env(safe-area-inset-*) via the custom pt-safe/pb-safe utilities.
 */
export function SafeArea({
  children,
  className = '',
  skipTop = false,
  skipBottom = false
}: SafeAreaProps) {
  return (
    <div
      className={`
        flex flex-col
        ${skipTop ? '' : 'pt-safe'}
        ${skipBottom ? '' : 'pb-safe'}
        pl-safe pr-safe
        h-dvh
        ${className}
      `}
    >
      {children}
    </div>
  )
}
