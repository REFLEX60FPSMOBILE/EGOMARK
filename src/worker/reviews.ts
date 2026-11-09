// Helpers du système d'avis vérifiés : validation, hachage, limitation de débit.
// Aucune donnée n'est inventée ici : tout vient de la table `orders` en D1.

export const REVIEW_AUTHOR_MIN = 2
export const REVIEW_AUTHOR_MAX = 40
export const REVIEW_BODY_MIN = 20
export const REVIEW_BODY_MAX = 1200
export const EMAIL_MAX = 254

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const ORDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export function isValidEmail(value: string): boolean {
  return value.length > 3 && value.length <= EMAIL_MAX && EMAIL_RE.test(value)
}

export function isValidOrderId(value: string): boolean {
  return ORDER_RE.test(value)
}

export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value)
}

// Nettoie un texte libre : pas de balises, pas de liens, longueur bornée.
export function cleanText(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (normalized.length < min || normalized.length > max) return null
  if (/[<>]/.test(normalized)) return null
  if (/(https?:\/\/|www\.)/i.test(normalized)) return null
  return normalized
}

export async function hashSecret(value: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${value}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const WINDOW_MS = 60 * 60 * 1000
const MAX_ATTEMPTS = 8
const attempts = new Map<string, number[]>()

// Limitation best-effort, par isolate : suffisante pour freiner le spam.
export function isRateLimited(key: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS)
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(key, recent)
    return true
  }
  recent.push(now)
  attempts.set(key, recent)
  if (attempts.size > 2000) attempts.clear()
  return false
}

export function clientIp(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip')
  if (direct) return direct
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return 'local'
}
