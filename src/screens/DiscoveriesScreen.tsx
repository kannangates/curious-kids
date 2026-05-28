import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { db } from '../db/index'
import type { LearnedObject } from '../db/index'
import { useAppStore } from '../store/app'
import { speak, stopSpeaking } from '../lib/voice'
import { LeoMascot } from '../components/LeoMascot'
import { SafeArea } from '../components/SafeArea'

// ─── Animal categorisation ────────────────────────────────────────────────────

const ANIMAL_SET = new Set([
  'lion', 'tiger', 'elephant', 'giraffe', 'zebra', 'penguin', 'dolphin',
  'whale', 'shark', 'eagle', 'parrot', 'monkey', 'gorilla', 'panda',
  'koala', 'kangaroo', 'crocodile', 'dinosaur', 'butterfly', 'caterpillar',
  'cheetah', 'leopard', 'jaguar', 'chimpanzee', 'flamingo', 'peacock',
  'toucan', 'octopus', 'jellyfish', 'starfish', 'seahorse', 'turtle',
  'rabbit', 'hamster', 'squirrel', 'hedgehog', 'raccoon', 'otter',
  'beaver', 'reindeer', 'moose', 'bison', 'camel', 'llama', 'alpaca',
  'meerkat', 'mongoose', 'chameleon', 'gecko', 'iguana', 'python',
  'cobra', 'scorpion', 'tarantula', 'firefly', 'ladybug', 'grasshopper',
  'cat', 'dog', 'bird', 'fish', 'frog', 'duck', 'cow', 'pig', 'hen',
  'horse', 'sheep', 'goat', 'deer', 'bear', 'fox', 'wolf', 'seal',
  'crab', 'snail', 'bee', 'ant', 'worm', 'spider', 'fly', 'moth'
])

type Category = 'all' | 'words' | 'animals' | 'objects'

function categorise(obj: LearnedObject): 'animals' | 'words' | 'objects' {
  const name = obj.objectName.toLowerCase().trim()
  if (ANIMAL_SET.has(name)) return 'animals'

  try {
    const t = JSON.parse(obj.translations) as Record<string, string>
    if (Object.keys(t).some(k => k !== 'en')) return 'words'
  } catch {
    // Fall through
  }

  return 'objects'
}

// ─── Days since helper ────────────────────────────────────────────────────────

function daysSince(isoDate: string): number {
  const diff = Date.now() - new Date(isoDate).getTime()
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
}

function daysAgoLabel(isoDate: string): string {
  const d = daysSince(isoDate)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return `${d} days ago`
}

// ─── Translation pill ─────────────────────────────────────────────────────────

const PILL_COLORS = [
  'bg-lavender-100 text-lavender-700',
  'bg-mint-100 text-mint-700',
  'bg-coral-100 text-coral-700',
  'bg-sky-100 text-sky-700',
  'bg-leo-100 text-leo-700'
]

const LANG_NAMES: Record<string, string> = {
  en: 'EN', kn: 'KN', hi: 'HI', ta: 'TA', te: 'TE'
}

interface TranslationPillProps {
  lang: string
  value: string
  colorIdx: number
}

function TranslationPill({ lang, value, colorIdx }: TranslationPillProps) {
  const color = PILL_COLORS[colorIdx % PILL_COLORS.length]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${color}`}>
      <span className="opacity-60 uppercase text-[10px]">{LANG_NAMES[lang] ?? lang}</span>
      <span className="truncate max-w-[60px]">{value}</span>
    </span>
  )
}

// ─── Discovery card ───────────────────────────────────────────────────────────

interface DiscoveryCardProps {
  item: LearnedObject
  onTap: (item: LearnedObject) => void
}

function DiscoveryCard({ item, onTap }: DiscoveryCardProps) {
  let translations: Record<string, string> = {}
  try {
    translations = JSON.parse(item.translations) as Record<string, string>
  } catch {
    translations = {}
  }

  const translationEntries = Object.entries(translations)
    .filter(([lang]) => lang !== 'en')
    .slice(0, 2)

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.95 }}
      onClick={() => onTap(item)}
      className="
        flex flex-col items-center gap-2
        bg-white rounded-3xl p-4 shadow-md
        border border-lavender-50
        active:shadow-lg transition-shadow
        text-center min-h-[130px]
      "
    >
      <span className="text-4xl leading-none">{item.emoji}</span>
      <p className="font-extrabold text-gray-700 text-sm leading-tight line-clamp-2">
        {item.objectName}
      </p>
      {translationEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 justify-center">
          {translationEntries.map(([lang, value], idx) => (
            <TranslationPill key={lang} lang={lang} value={value} colorIdx={idx} />
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 font-medium mt-auto">
        {daysAgoLabel(item.learnedAt)}
      </p>
    </motion.button>
  )
}

// ─── Expanded card modal ──────────────────────────────────────────────────────

interface ExpandedCardProps {
  item: LearnedObject
  primaryLang: string
  onClose: () => void
  onAskLeo: (item: LearnedObject) => void
}

function ExpandedCard({ item, primaryLang, onClose, onAskLeo }: ExpandedCardProps) {
  let translations: Record<string, string> = {}
  try {
    translations = JSON.parse(item.translations) as Record<string, string>
  } catch {
    translations = {}
  }

  const allTranslations = Object.entries(translations)
  const nonEnglish = allTranslations.filter(([lang]) => lang !== 'en')

  const handleSpeak = (text: string, lang: string) => {
    speak(text, lang).catch(console.error)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 z-50 flex items-end justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: '100%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Close handle */}
        <div className="flex justify-center mb-4">
          <div className="w-12 h-1 bg-gray-200 rounded-full" />
        </div>

        {/* Title */}
        <div className="flex items-center gap-3 mb-4">
          <span className="text-5xl">{item.emoji}</span>
          <div>
            <p className="font-extrabold text-2xl text-gray-800">{item.objectName}</p>
            <p className="text-xs text-gray-400 font-medium">{daysAgoLabel(item.learnedAt)}</p>
          </div>
        </div>

        {/* All translations */}
        {nonEnglish.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
              Translations
            </p>
            <div className="flex flex-col gap-2">
              {nonEnglish.map(([lang, value], idx) => (
                <div
                  key={lang}
                  className="flex items-center justify-between bg-lavender-50 rounded-2xl px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <TranslationPill lang={lang} value={value} colorIdx={idx} />
                    <span className="text-sm font-bold text-gray-700">{value}</span>
                  </div>
                  <button
                    onClick={() => handleSpeak(value, lang)}
                    className="w-9 h-9 flex items-center justify-center bg-white rounded-full shadow-sm text-lg active:scale-90"
                    aria-label={`Speak ${value}`}
                  >
                    🔊
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* English pronunciation */}
        <div className="flex items-center justify-between bg-sky-50 rounded-2xl px-3 py-2 mb-4">
          <span className="text-sm font-bold text-sky-700">
            English: <span className="font-extrabold">{item.objectName}</span>
          </span>
          <button
            onClick={() => handleSpeak(item.objectName, primaryLang)}
            className="w-9 h-9 flex items-center justify-center bg-white rounded-full shadow-sm text-lg active:scale-90"
            aria-label={`Speak ${item.objectName}`}
          >
            🔊
          </button>
        </div>

        {/* Ask Leo more */}
        <button
          onClick={() => onAskLeo(item)}
          className="
            w-full py-4 rounded-3xl font-extrabold text-white text-base
            bg-gradient-to-r from-lavender-500 to-lavender-700
            shadow-lg active:scale-95 transition-transform
          "
        >
          Ask Leo more about {item.objectName}! 🦁
        </button>

        <button
          onClick={onClose}
          className="w-full mt-2 py-2 text-lavender-400 font-semibold text-sm"
        >
          Close
        </button>
      </motion.div>
    </motion.div>
  )
}

// ─── Tab button ───────────────────────────────────────────────────────────────

interface TabButtonProps {
  label: string
  active: boolean
  count: number
  onClick: () => void
}

function TabButton({ label, active, count, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-1 px-3 py-2 rounded-2xl text-sm font-bold
        transition-all duration-200 flex-shrink-0
        ${active
          ? 'bg-lavender-500 text-white shadow-md'
          : 'bg-white/70 text-lavender-600 hover:bg-white'
        }
      `}
    >
      {label}
      {count > 0 && (
        <span className={`
          text-xs rounded-full px-1.5 py-0.5 font-extrabold
          ${active ? 'bg-white/30 text-white' : 'bg-lavender-100 text-lavender-600'}
        `}>
          {count}
        </span>
      )}
    </button>
  )
}

// ─── DiscoveriesScreen ────────────────────────────────────────────────────────

export function DiscoveriesScreen() {
  const navigate = useNavigate()
  const { profile } = useAppStore()
  const primaryLang = profile?.preferredLanguages[0] ?? 'en'

  const [allItems, setAllItems] = useState<LearnedObject[]>([])
  const [activeTab, setActiveTab] = useState<Category>('all')
  const [expandedItem, setExpandedItem] = useState<LearnedObject | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // ── Load discoveries ───────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!profile) { setIsLoading(false); return }
      try {
        const items = await db.learnedObjects
          .where('profileId')
          .equals(profile.id)
          .toArray()

        const sorted = items.sort(
          (a, b) => new Date(b.learnedAt).getTime() - new Date(a.learnedAt).getTime()
        )

        if (!cancelled) {
          setAllItems(sorted)
          setIsLoading(false)
        }
      } catch (err) {
        console.error('[Discoveries] load failed:', err)
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [profile])

  // ── Cleanup speech on unmount ──────────────────────────────────────────────

  useEffect(() => {
    return () => { stopSpeaking() }
  }, [])

  // ── Filtered items ─────────────────────────────────────────────────────────

  const filtered = allItems.filter(item => {
    if (activeTab === 'all') return true
    const cat = categorise(item)
    return cat === activeTab
  })

  const categoryCounts: Record<Category, number> = {
    all: allItems.length,
    words: allItems.filter(i => categorise(i) === 'words').length,
    animals: allItems.filter(i => categorise(i) === 'animals').length,
    objects: allItems.filter(i => categorise(i) === 'objects').length
  }

  // ── Ask Leo more ───────────────────────────────────────────────────────────

  const handleAskLeo = (item: LearnedObject) => {
    setExpandedItem(null)
    navigate(`/chat?q=Tell+me+more+about+${encodeURIComponent(item.objectName)}`)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeArea className="bg-gradient-to-br from-mint-50 via-lavender-50 to-leo-50 overflow-hidden">
      <div className="flex flex-col flex-1 max-w-sm mx-auto w-full overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-sm border-b border-lavender-100">
          <button
            onClick={() => navigate('/')}
            className="w-10 h-10 flex items-center justify-center text-xl rounded-full bg-lavender-100 active:scale-90 flex-shrink-0"
            aria-label="Go back"
          >
            ←
          </button>
          <div className="flex-1">
            <p className="font-extrabold text-lavender-700 text-lg">⭐ My Discoveries</p>
          </div>
          {allItems.length > 0 && (
            <span className="
              bg-lavender-500 text-white text-xs font-extrabold
              px-2.5 py-1 rounded-full flex-shrink-0
            ">
              {allItems.length}
            </span>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2 px-4 py-3 overflow-x-auto scrollbar-hide bg-white/50 border-b border-lavender-100">
          {(['all', 'words', 'animals', 'objects'] as Category[]).map(tab => (
            <TabButton
              key={tab}
              label={tab.charAt(0).toUpperCase() + tab.slice(1)}
              active={activeTab === tab}
              count={tab === 'all' ? 0 : categoryCounts[tab]}
              onClick={() => setActiveTab(tab)}
            />
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">

          {/* Loading */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <LeoMascot size="md" mood="thinking" />
              <p className="text-sm font-bold text-lavender-500 animate-pulse">
                Loading your discoveries...
              </p>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && allItems.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center py-12 gap-4 text-center"
            >
              <LeoMascot size="lg" mood="sleeping" />
              <p className="text-base font-extrabold text-lavender-600 mt-2">
                Go explore and come back!
              </p>
              <p className="text-sm text-gray-400 font-medium max-w-[200px]">
                Your discoveries will show up here once you start learning!
              </p>
              <button
                onClick={() => navigate('/chat')}
                className="
                  mt-2 px-6 py-3 bg-gradient-to-r from-lavender-500 to-lavender-700
                  text-white font-extrabold text-base rounded-3xl shadow-lg active:scale-95
                "
              >
                Start Exploring 🚀
              </button>
            </motion.div>
          )}

          {/* Empty filter state */}
          {!isLoading && allItems.length > 0 && filtered.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-12 gap-3 text-center"
            >
              <span className="text-5xl">
                {activeTab === 'animals' ? '🦁' : activeTab === 'words' ? '🌍' : '🔍'}
              </span>
              <p className="text-sm font-bold text-lavender-500">
                No {activeTab} discovered yet!
              </p>
            </motion.div>
          )}

          {/* Grid */}
          {!isLoading && filtered.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <AnimatePresence>
                {filtered.map((item, idx) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.04, 0.4) }}
                  >
                    <DiscoveryCard
                      item={item}
                      onTap={setExpandedItem}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Expanded card overlay */}
      <AnimatePresence>
        {expandedItem && (
          <ExpandedCard
            item={expandedItem}
            primaryLang={primaryLang}
            onClose={() => setExpandedItem(null)}
            onAskLeo={handleAskLeo}
          />
        )}
      </AnimatePresence>
    </SafeArea>
  )
}
