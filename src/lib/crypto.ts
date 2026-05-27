// WebCrypto-based encryption for the Gemini API key.
// The key is derived from the user's Google sub ID using PBKDF2,
// so only the authenticated user can decrypt it.

const SALT = new TextEncoder().encode('curiouskie-v1')
const ITERATIONS = 100_000
const KEY_USAGE: KeyUsage[] = ['encrypt', 'decrypt']

/**
 * Derives a 256-bit AES-GCM key from the user's Google sub ID.
 * Uses PBKDF2 with SHA-256 and a fixed salt.
 */
export async function deriveKeyFromSub(sub: string): Promise<CryptoKey> {
  try {
    const encoder = new TextEncoder()
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(sub),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

    return await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: SALT,
        iterations: ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      KEY_USAGE
    )
  } catch (err) {
    throw new Error(`Failed to derive encryption key: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface EncryptedPayload {
  iv: string        // base64-encoded IV
  ciphertext: string // base64-encoded ciphertext
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Encrypts the Gemini API key using AES-GCM-256 derived from the Google sub.
 * Returns a base64-encoded JSON string containing the IV and ciphertext.
 */
export async function encryptApiKey(apiKey: string, sub: string): Promise<string> {
  try {
    const key = await deriveKeyFromSub(sub)
    const encoder = new TextEncoder()
    const iv = window.crypto.getRandomValues(new Uint8Array(12)) // 96-bit IV for AES-GCM

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(apiKey)
    )

    const payload: EncryptedPayload = {
      iv: arrayBufferToBase64(iv.buffer),
      ciphertext: arrayBufferToBase64(ciphertext)
    }

    return btoa(JSON.stringify(payload))
  } catch (err) {
    throw new Error(`Failed to encrypt API key: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Hashes a parent PIN with SHA-256 (salted) → hex string.
 * The PIN only gates the child UI; the raw PIN is never stored.
 */
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`curiouskie-pin-v1:${pin}`)
  const digest = await window.crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Returns true if the entered PIN matches the stored hash. */
export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return true // no PIN set → always allowed
  const h = await hashPin(pin)
  return h === storedHash
}

/**
 * Decrypts a Gemini API key that was encrypted with encryptApiKey.
 * Requires the same Google sub used during encryption.
 */
export async function decryptApiKey(encrypted: string, sub: string): Promise<string> {
  try {
    const payload: EncryptedPayload = JSON.parse(atob(encrypted))
    const key = await deriveKeyFromSub(sub)

    const iv = base64ToArrayBuffer(payload.iv)
    const ciphertext = base64ToArrayBuffer(payload.ciphertext)

    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    )

    return new TextDecoder().decode(plaintext)
  } catch (err) {
    throw new Error(`Failed to decrypt API key: ${err instanceof Error ? err.message : String(err)}`)
  }
}
