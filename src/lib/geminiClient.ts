import { db } from '../db/index'
import { decryptApiKey } from './crypto'
import { createGeminiClient, type GeminiClient } from './gemini'

/** Thrown when no API key has been set up yet. */
export class NoApiKeyError extends Error {
  constructor() {
    super('No Gemini API key configured')
    this.name = 'NoApiKeyError'
  }
}

/**
 * Loads a configured Gemini client: decrypts the stored key with the Google
 * `sub` and applies the parent's chosen chat/vision models. Centralises the
 * boilerplate the screens used to repeat.
 */
export async function loadGeminiClient(googleSub: string): Promise<GeminiClient> {
  const settings = await db.appSettings.get('main')
  if (!settings?.apiKeyEncrypted) throw new NoApiKeyError()
  const apiKey = await decryptApiKey(settings.apiKeyEncrypted, googleSub)
  return createGeminiClient(apiKey, {
    chatModel: settings.chatModel,
    visionModel: settings.visionModel
  })
}
