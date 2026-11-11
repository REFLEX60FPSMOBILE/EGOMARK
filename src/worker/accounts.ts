// Comptes client optionnels : mot de passe PBKDF2, sessions HttpOnly et 2FA
// TOTP. Le suivi par jeton de commande reste disponible sans compte.

import { hashSecret, sameSecret } from './reviews'

export const CLIENT_SESSION_COOKIE = 'ego_client_session'
export const CLIENT_SESSION_DAYS = 30
const PASSWORD_ITERATIONS = 100_000
const PASSWORD_MIN = 8
const PASSWORD_MAX = 128
const TOTP_STEP_SECONDS = 30

export type ClientAccount = {
  id: string
  emailMasked: string
  totpEnabled: boolean
  displayName: string
  avatarUrl: string | null
  discordId: string | null
  discordUsername: string | null
  provider: 'password' | 'discord'
}

export type ClientSession = {
  sessionId: string
  account: ClientAccount
}

const encoder = new TextEncoder()

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const randomHex = (bytes = 32): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length > 254) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null
  return email
}

export const maskEmail = (email: string): string => {
  const at = email.indexOf('@')
  if (at <= 0) return '•••'
  return `${email.slice(0, 1)}•••${email.slice(at)}`
}

export const isStrongEnoughPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX

export async function hashEmail(email: string, salt: string): Promise<string> {
  return hashSecret(`client-email:${email}`, salt)
}

export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations: PASSWORD_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    256,
  )
  return {
    hash: bytesToBase64(new Uint8Array(bits)),
    salt,
    iterations: PASSWORD_ITERATIONS,
  }
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
      'deriveBits',
    ])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(salt),
        iterations,
        hash: 'SHA-256',
      },
      key,
      256,
    )
    const actual = bytesToBase64(new Uint8Array(bits))
    return sameSecret(actual, storedHash)
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ TOTP

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(value: string): Uint8Array<ArrayBuffer> {
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let current = 0
  const output: number[] = []
  for (const char of cleaned) {
    const index = BASE32.indexOf(char)
    if (index < 0) continue
    current = (current << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(output)
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)))
}

const counterBytes = (counter: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(8)
  let value = counter
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value & 255
    value = Math.floor(value / 256)
  }
  return bytes
}

async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, counterBytes(step)),
  )
  const offset = signature[signature.length - 1] & 0x0f
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

export async function verifyTotp(secret: string, code: string, window = 1): Promise<boolean> {
  if (!secret || !/^\d{6}$/.test(code)) return false
  const current = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)
  for (let offset = -window; offset <= window; offset += 1) {
    if ((await totpAt(secret, current + offset)) === code) return true
  }
  return false
}

export function otpauthUrl(email: string, secret: string, issuer = 'EGO Market'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

// --------------------------------------------------------------- cookies

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie') || ''
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

export function readSessionToken(request: Request): string {
  return (parseCookies(request)[CLIENT_SESSION_COOKIE] || '').trim()
}

const cookieSecure = (request: Request): boolean => new URL(request.url).protocol === 'https:'

export function sessionCookie(token: string, request: Request): string {
  const parts = [
    `${CLIENT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CLIENT_SESSION_DAYS * 24 * 60 * 60}`,
  ]
  if (cookieSecure(request)) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(request: Request): string {
  const parts = [`${CLIENT_SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (cookieSecure(request)) parts.push('Secure')
  return parts.join('; ')
}

export async function getClientSession(
  db: D1Database,
  request: Request,
  salt: string,
): Promise<ClientSession | null> {
  const token = readSessionToken(request)
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const tokenHash = await hashSecret(`client-session:${token}`, salt)
  const now = new Date().toISOString()
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, a.id AS account_id, a.email_masked, a.totp_enabled
       FROM client_sessions s JOIN client_accounts a ON a.id = s.account_id
       WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<{
      session_id: string
      account_id: string
      email_masked: string
      totp_enabled: number
    }>()
  if (!row) return null
  await db
    .prepare('UPDATE client_sessions SET last_seen_at = ?1 WHERE id = ?2')
    .bind(now, row.session_id)
    .run()
    .catch(() => {})
  let identity: {
    discord_id: string
    username: string
    display_name: string | null
    avatar_url: string | null
  } | null = null
  try {
    identity = await db
      .prepare(
        'SELECT discord_id, username, display_name, avatar_url FROM discord_identities WHERE account_id = ?1',
      )
      .bind(row.account_id)
      .first<{
        discord_id: string
        username: string
        display_name: string | null
        avatar_url: string | null
      }>()
  } catch {
    // La table peut ne pas encore exister sur une base antérieure à la 0006.
    identity = null
  }
  return {
    sessionId: row.session_id,
    account: {
      id: row.account_id,
      emailMasked: row.email_masked,
      totpEnabled: Number(row.totp_enabled) === 1,
      displayName: identity?.display_name || identity?.username || row.email_masked,
      avatarUrl: identity?.avatar_url ?? null,
      discordId: identity?.discord_id ?? null,
      discordUsername: identity?.username ?? null,
      provider: identity ? 'discord' : 'password',
    },
  }
}

export async function createClientSession(
  db: D1Database,
  accountId: string,
  request: Request,
  salt: string,
  ipHash: string,
): Promise<{ token: string; sessionId: string }> {
  const token = randomHex(32)
  const tokenHash = await hashSecret(`client-session:${token}`, salt)
  const sessionId = crypto.randomUUID()
  const now = new Date()
  const expires = new Date(now.getTime() + CLIENT_SESSION_DAYS * 24 * 60 * 60 * 1000)
  await db
    .prepare(
      'INSERT INTO client_sessions (id, account_id, token_hash, created_at, last_seen_at, expires_at, ip_hash, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      sessionId,
      accountId,
      tokenHash,
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
      ipHash,
      (request.headers.get('user-agent') || '').slice(0, 255),
    )
    .run()
  return { token, sessionId }
}

export async function recordClientLogin(
  db: D1Database,
  accountId: string,
  kind: string,
  request: Request,
  ipHash: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO client_login_events (id, account_id, kind, ip_hash, user_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    .bind(
      crypto.randomUUID(),
      accountId,
      kind.slice(0, 40),
      ipHash,
      (request.headers.get('user-agent') || '').slice(0, 255),
      new Date().toISOString(),
    )
    .run()
    .catch(() => {})
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}
