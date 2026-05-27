import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerativeModel
} from '@google/generative-ai'

// ─── Custom error types ───────────────────────────────────────────────────────

export class SafetyError extends Error {
  constructor(message = 'Response blocked by safety filters') {
    super(message)
    this.name = 'SafetyError'
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network request failed') {
    super(message)
    this.name = 'NetworkError'
  }
}

export class ApiKeyError extends Error {
  constructor(message = 'The Gemini API key is not valid') {
    super(message)
    this.name = 'ApiKeyError'
  }
}

/** True when an error indicates the Gemini API key itself is invalid. */
function isInvalidKeyError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('API_KEY_INVALID') ||
    err.message.includes('API key not valid')
  )
}

/**
 * Cheaply verifies a Gemini API key by listing models (no generation cost).
 * Returns { ok:true } on success. On a definitive bad key returns ok:false
 * with a message. Network/CORS failures resolve ok:true so we never block
 * setup just because validation couldn't run.
 */
export async function validateApiKey(apiKey: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`
    )
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null) as
      | { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } }
      | null
    const message = body?.error?.message ?? `Key check failed (HTTP ${res.status}).`
    return { ok: false, message }
  } catch {
    // Couldn't reach Google (offline/CORS) — don't hard-block on validation
    return { ok: true }
  }
}

/**
 * Lists the model names this API key can use for content generation
 * (i.e. those supporting `generateContent`). Returns short names like
 * "gemini-2.0-flash" (the "models/" prefix is stripped). Throws on failure.
 */
export async function listAvailableModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`
  )
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Could not load models (HTTP ${res.status}).`)
  }
  const body = await res.json() as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
  }
  return (body.models ?? [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort()
}

/**
 * True only for genuine connectivity failures — NOT for HTTP status errors.
 * The Gemini SDK wraps every API error in a message beginning
 * "[GoogleGenerativeAI Error]: Error fetching from ...", which contains the
 * word "fetch"; we must NOT treat those (400/403/404/429/5xx) as offline,
 * or their real status/reason gets hidden behind a generic offline message.
 */
function isOfflineError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  if (err instanceof TypeError) return true // browser fetch() throws TypeError when truly offline
  if (err instanceof Error) {
    return (
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError when attempting to fetch') ||
      err.message.includes('ERR_INTERNET_DISCONNECTED') ||
      err.message.includes('ERR_NETWORK')
    )
  }
  return false
}

// ─── Safety settings ──────────────────────────────────────────────────────────

const SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
  }
]

// ─── Gemini client factory ────────────────────────────────────────────────────

export interface GeminiClient {
  streamChat(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void
  ): Promise<string>
  analyzeImage(base64Image: string, prompt: string): Promise<string>
}

export interface GeminiModelOptions {
  chatModel?: string
  visionModel?: string
}

const FALLBACK_CHAT_MODEL = 'gemini-2.0-flash'
const FALLBACK_VISION_MODEL = 'gemini-2.0-flash'

export function createGeminiClient(apiKey: string, opts: GeminiModelOptions = {}): GeminiClient {
  const genAI = new GoogleGenerativeAI(apiKey)
  const chatModelName = opts.chatModel?.trim() || FALLBACK_CHAT_MODEL
  const visionModelName = opts.visionModel?.trim() || FALLBACK_VISION_MODEL

  function getChatModel(): GenerativeModel {
    return genAI.getGenerativeModel({
      model: chatModelName,
      safetySettings: SAFETY_SETTINGS,
      // Higher temperature + topP → more varied, less formulaic answers
      generationConfig: { temperature: 1.0, topP: 0.95 }
    })
  }

  function getVisionModel(): GenerativeModel {
    return genAI.getGenerativeModel({
      model: visionModelName,
      safetySettings: SAFETY_SETTINGS,
      // Lower temperature → reliable JSON for object identification
      generationConfig: { temperature: 0.4, topP: 0.9 }
    })
  }

  return {
    /**
     * Streams a chat response from Gemini.
     * Calls onChunk for each text chunk received.
     * Returns the full concatenated response text.
     */
    async streamChat(
      systemPrompt: string,
      userMessage: string,
      onChunk: (text: string) => void
    ): Promise<string> {
      try {
        const model = getChatModel()
        const result = await model.generateContentStream({
          systemInstruction: systemPrompt,
          contents: [
            { role: 'user', parts: [{ text: userMessage }] }
          ]
        })

        let fullText = ''

        for await (const chunk of result.stream) {
          // Check if blocked by safety
          const candidate = chunk.candidates?.[0]
          if (candidate?.finishReason === 'SAFETY') {
            throw new SafetyError('Response was blocked by safety filters')
          }

          // chunk.text() can throw for non-text/finish chunks (e.g. RECITATION,
          // empty candidates). Don't let one bad chunk kill the whole reply.
          let chunkText = ''
          try {
            chunkText = chunk.text()
          } catch {
            chunkText = ''
          }
          if (chunkText) {
            fullText += chunkText
            onChunk(chunkText)
          }
        }

        // Check final response for safety block
        const response = await result.response
        const finishReason = response.candidates?.[0]?.finishReason
        if (finishReason === 'SAFETY') {
          throw new SafetyError('Response was blocked by safety filters')
        }

        return fullText
      } catch (err) {
        if (err instanceof SafetyError) throw err
        if (isInvalidKeyError(err)) {
          throw new ApiKeyError('The Gemini magic key is not valid. Ask a parent to update it in Settings.')
        }
        if (isOfflineError(err)) {
          throw new NetworkError('You seem to be offline — please check your connection.')
        }
        // Surface the real SDK message (includes HTTP status + reason)
        throw new Error(
          `Gemini chat error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },

    /**
     * Analyzes an image with a text prompt.
     * Returns the model's text response.
     */
    async analyzeImage(base64Image: string, prompt: string): Promise<string> {
      try {
        const model = getVisionModel()

        // Strip the data URL prefix if present (e.g., "data:image/jpeg;base64,")
        const imageData = base64Image.includes(',')
          ? base64Image.split(',')[1]
          : base64Image

        const mimeType = base64Image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'

        const result = await model.generateContent([
          {
            inlineData: {
              mimeType,
              data: imageData
            }
          },
          { text: prompt }
        ])

        const response = result.response
        const finishReason = response.candidates?.[0]?.finishReason
        if (finishReason === 'SAFETY') {
          throw new SafetyError('Image response was blocked by safety filters')
        }

        return response.text()
      } catch (err) {
        if (err instanceof SafetyError) throw err
        if (isInvalidKeyError(err)) {
          throw new ApiKeyError('The Gemini magic key is not valid. Ask a parent to update it in Settings.')
        }
        if (isOfflineError(err)) {
          throw new NetworkError('You seem to be offline — please check your connection.')
        }
        // Surface the real SDK message (includes HTTP status + reason)
        throw new Error(
          `Gemini vision error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}
