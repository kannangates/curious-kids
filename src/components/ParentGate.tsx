import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { db } from '../db/index'
import { verifyPin } from '../lib/crypto'
import { LeoMascot } from './LeoMascot'
import { SafeArea } from './SafeArea'

// Remembered for the app session so switching Settings <-> Dashboard
// doesn't re-prompt. Resets on a full page reload (re-prompt once per visit).
let sessionUnlocked = false

/** Call after the parent sets/clears a PIN so the gate state stays correct. */
export function markParentUnlocked() {
  sessionUnlocked = true
}
export function lockParent() {
  sessionUnlocked = false
}

interface ParentGateProps {
  children: ReactNode
}

export function ParentGate({ children }: ParentGateProps) {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'open' | 'locked'>('loading')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const s = await db.appSettings.get('main')
        const hash = s?.parentPinHash ?? ''
        if (cancelled) return
        setStatus(!hash || sessionUnlocked ? 'open' : 'locked')
      } catch {
        if (!cancelled) setStatus('open')
      }
    }
    void check()
    return () => { cancelled = true }
  }, [])

  const submit = useCallback(async (entered: string) => {
    const s = await db.appSettings.get('main')
    const ok = await verifyPin(entered, s?.parentPinHash ?? '')
    if (ok) {
      sessionUnlocked = true
      setStatus('open')
    } else {
      setError(true)
      setTimeout(() => { setError(false); setPin('') }, 700)
    }
  }, [])

  useEffect(() => {
    if (status === 'locked' && pin.length === 4) void submit(pin)
  }, [pin, status, submit])

  const press = (d: string) => {
    if (error) return
    setPin(p => (p.length < 4 ? p + d : p))
  }
  const backspace = () => setPin(p => p.slice(0, -1))

  if (status === 'loading') {
    return (
      <SafeArea className="bg-lavender-50 flex items-center justify-center">
        <div className="w-9 h-9 border-4 border-lavender-300 border-t-lavender-600 rounded-full animate-spin" />
      </SafeArea>
    )
  }

  if (status === 'open') return <>{children}</>

  // Locked → PIN entry
  return (
    <SafeArea className="bg-gradient-to-br from-lavender-100 to-white">
      <div className="flex flex-col flex-1 items-center justify-center gap-6 px-6 max-w-xs mx-auto w-full">
        <LeoMascot size="md" mood="thinking" />
        <div className="text-center">
          <h1 className="text-2xl font-extrabold text-lavender-700">Parent Zone 🔒</h1>
          <p className="text-sm text-gray-500 font-medium mt-1">Enter your 4-digit PIN</p>
        </div>

        {/* PIN dots */}
        <motion.div
          className="flex gap-4"
          animate={error ? { x: [0, -8, 8, -8, 8, 0] } : {}}
          transition={{ duration: 0.4 }}
        >
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className={`w-5 h-5 rounded-full border-2 transition-colors ${
                error
                  ? 'border-red-400 bg-red-400'
                  : i < pin.length
                  ? 'border-lavender-500 bg-lavender-500'
                  : 'border-lavender-300 bg-transparent'
              }`}
            />
          ))}
        </motion.div>

        {error && <p className="text-sm font-bold text-red-500 -mt-2">Oops, try again!</p>}

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
            <button
              key={d}
              onClick={() => press(d)}
              className="h-16 rounded-2xl bg-white shadow-sm border border-lavender-100 text-2xl font-extrabold text-lavender-700 active:scale-90 active:bg-lavender-50"
            >
              {d}
            </button>
          ))}
          <div />
          <button
            onClick={() => press('0')}
            className="h-16 rounded-2xl bg-white shadow-sm border border-lavender-100 text-2xl font-extrabold text-lavender-700 active:scale-90 active:bg-lavender-50"
          >
            0
          </button>
          <button
            onClick={backspace}
            className="h-16 rounded-2xl bg-lavender-50 text-2xl font-extrabold text-lavender-400 active:scale-90"
            aria-label="Delete"
          >
            ⌫
          </button>
        </div>

        <button onClick={() => navigate('/')} className="text-sm text-lavender-400 font-semibold">
          ← Back to Leo
        </button>
      </div>
    </SafeArea>
  )
}
