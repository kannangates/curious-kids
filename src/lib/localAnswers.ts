// Answers Leo can give instantly from the device — no AI/clock guesswork.
// LLMs don't know the current time/date, so we handle those locally for a
// correct, immediate, kid-friendly answer (works offline too).

export function getLocalAnswer(text: string): string | null {
  if (!text) return null
  const q = text.toLowerCase()
  const asks = /(what|what's|whats|whats|which|tell me|do you know)/.test(q)
  const now = new Date()

  // Time
  if (asks && /\btime\b/.test(q)) {
    const t = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    const h = now.getHours()
    const part = h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : h < 21 ? 'in the evening' : 'at night'
    return `Right now it's ${t} ${part}! ⏰ What would you like to explore?`
  }

  // Full date
  if (asks && /\bdate\b/.test(q)) {
    const d = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    return `Today is ${d}! 📅`
  }

  // Day of week
  if (asks && /\b(day|today)\b/.test(q) && /\bday\b/.test(q)) {
    const day = now.toLocaleDateString(undefined, { weekday: 'long' })
    return `Today is ${day}! 😊 A great day to learn something new!`
  }

  // Year
  if (asks && /\byear\b/.test(q)) {
    return `It's the year ${now.getFullYear()}! 🎉`
  }

  // Month
  if (asks && /\bmonth\b/.test(q)) {
    const m = now.toLocaleDateString(undefined, { month: 'long' })
    return `It's ${m}! 🌈`
  }

  return null
}
