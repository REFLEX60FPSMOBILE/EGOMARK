// Intégration Stripe : Checkout hébergé côté serveur, vérification de la
// signature `stripe-signature` et lecture de l'événement `checkout.session.completed`.
// Aucun montant envoyé par le navigateur n'est utilisé : le prix vient de
// `./prices`, généré depuis le catalogue.

import { isValidEmail, isValidOrderId, isValidSlug, sameSecret } from './reviews'
import { PRICES } from './prices'

export const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions'
export const SIGNATURE_TOLERANCE_SECONDS = 300
export const WEBHOOK_BODY_MAX = 64 * 1024

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return hex(signature)
}

// En-tête Stripe : `t=<horodatage>,v1=<signature>[,v1=<autre>]`.
// Plusieurs signatures peuvent coexister pendant une rotation de secret.
export function parseSignatureHeader(header: string | null): { timestamp: number; signatures: string[] } | null {
  if (!header) return null
  let timestamp = Number.NaN
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1' && value) signatures.push(value.toLowerCase())
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null
  return { timestamp, signatures }
}

// Signature = HMAC-SHA256(secret, "<t>.<corps brut>"), comparée en temps constant.
export async function verifyStripeSignature(input: {
  payload: string
  header: string | null
  secret: string
  nowMs?: number
  toleranceSeconds?: number
}): Promise<boolean> {
  const parsed = parseSignatureHeader(input.header)
  if (!parsed) return false

  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000)
  if (Math.abs(now - parsed.timestamp) > tolerance) return false

  const expected = await hmacHex(input.secret, `${parsed.timestamp}.${input.payload}`)
  return parsed.signatures.some((signature) => sameSecret(expected, signature))
}

export function isStripeConfigured(env: { STRIPE_SECRET_KEY?: string }): boolean {
  const key = env.STRIPE_SECRET_KEY
  return typeof key === 'string' && key.trim().length > 10
}

// Identifiant de commande lisible, compatible avec ORDER_RE côté avis.
export function newOrderId(): string {
  const stamp = Date.now().toString(36).toUpperCase().slice(-6)
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()
  return `EGO-${stamp}${random}`
}

export type CheckoutSession = { id: string; url: string }

// Crée une session Checkout hébergée. La clé d'idempotence évite les doublons
// si le client rejoue la requête.
export type CheckoutItem = { slug: string; name: string; amountCents: number; quantity: number }

export async function createCheckoutSession(
  secretKey: string,
  input: {
    orderId: string
    items: CheckoutItem[]
    origin: string
    email?: string
  },
): Promise<CheckoutSession> {
  const single = input.items.length === 1
  const body = new URLSearchParams()
  body.set('mode', 'payment')
  body.set('client_reference_id', input.orderId)
  body.set('success_url', single ? `${input.origin}/reviews/?order=${encodeURIComponent(input.orderId)}` : `${input.origin}/reviews/`)
  body.set('cancel_url', single ? `${input.origin}/product/${input.items[0].slug}/` : `${input.origin}/`)
  input.items.forEach((item, index) => {
    body.set(`line_items[${index}][quantity]`, String(item.quantity))
    body.set(`line_items[${index}][price_data][currency]`, 'eur')
    body.set(`line_items[${index}][price_data][unit_amount]`, String(item.amountCents))
    body.set(`line_items[${index}][price_data][product_data][name]`, item.name.slice(0, 120))
    body.set(`metadata[item_${index}]`, `${item.slug}|${item.quantity}`)
  })
  body.set('metadata[order_id]', input.orderId)
  body.set('metadata[item_count]', String(input.items.length))
  if (single) {
    body.set('metadata[product_slug]', input.items[0].slug)
    body.set('metadata[product_name]', input.items[0].name.slice(0, 120))
  }
  if (input.email) body.set('customer_email', input.email)

  const response = await fetch(STRIPE_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': input.orderId,
    },
    body,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`stripe_${response.status}:${detail.slice(0, 200)}`)
  }

  const session = (await response.json()) as { id?: string; url?: string | null }
  if (!session.url) throw new Error('stripe_missing_url')
  return { id: session.id ?? input.orderId, url: session.url }
}

export type PaidOrder = {
  orderId: string
  email: string
  productSlug: string
  productName: string | null
  amountCents: number | null
  currency: string
  paidAt: string
  paymentRef: string | null
}

export type ParsedStripeEvent =
  | { kind: 'ignored'; type: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'orders'; orders: PaidOrder[] }

export function parseCheckoutCompleted(event: unknown): ParsedStripeEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { kind: 'invalid', error: 'invalid_event' }
  }

  const record = event as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!type) return { kind: 'invalid', error: 'invalid_event' }

  // `completed` couvre la carte ; `async_payment_succeeded` arrive plus tard
  // pour les moyens de paiement différés.
  const orderEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])
  if (!orderEvents.has(type)) return { kind: 'ignored', type }

  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : {}
  const session = data.object && typeof data.object === 'object' ? (data.object as Record<string, unknown>) : {}
  const metadata = session.metadata && typeof session.metadata === 'object' ? (session.metadata as Record<string, unknown>) : {}
  const customer = session.customer_details && typeof session.customer_details === 'object'
    ? (session.customer_details as Record<string, unknown>)
    : {}

  const orderId = String(session.client_reference_id ?? metadata.order_id ?? '').trim()
  const email = String(customer.email ?? session.customer_email ?? '').trim().toLowerCase()

  if (!isValidOrderId(orderId)) return { kind: 'invalid', error: 'invalid_order' }
  if (!isValidEmail(email)) return { kind: 'invalid', error: 'invalid_email' }

  // Une session peut être `completed` sans être payée (paiement différé) :
  // on n'ouvre le droit à l'avis que si l'argent est effectivement encaissé.
  const paymentStatus = String(session.payment_status ?? '')
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    // Acquitté sans effet : Stripe renverra l'événement async plus tard.
    return { kind: 'ignored', type }
  }

  const rawCurrency = String(session.currency ?? 'eur').trim().toUpperCase()
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'EUR'

  const created = Number(session.created)
  const paidAt = Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : new Date().toISOString()

  const paymentRefBase = String(session.payment_intent ?? session.id ?? '').trim().slice(0, 110) || null

  // Panier : une entrée `item_i` = `slug|quantité`. Chaque article reçoit sa
  // propre commande (donc son propre droit à un avis vérifié) et sa propre
  // référence de paiement.
  const cartEntries = Object.entries(metadata)
    .filter(([key, value]) => /^item_\d+$/.test(key) && typeof value === 'string')
    .sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)))

  if (cartEntries.length) {
    const orders: PaidOrder[] = []
    cartEntries.forEach(([, value], index) => {
      const [rawSlug, rawQuantity] = String(value).split('|')
      const itemSlug = (rawSlug ?? '').trim()
      if (!isValidSlug(itemSlug)) return
      const entry = PRICES[itemSlug]
      if (!entry) return
      const parsedQuantity = Number.parseInt(rawQuantity ?? '1', 10)
      const itemQuantity = Number.isFinite(parsedQuantity) ? Math.min(Math.max(parsedQuantity, 1), 10) : 1
      orders.push({
        orderId: `${orderId}-${index + 1}`,
        email,
        productSlug: itemSlug,
        productName: entry.name.slice(0, 120),
        amountCents: entry.amountCents * itemQuantity,
        currency,
        paidAt,
        paymentRef: paymentRefBase ? `${paymentRefBase}#${index + 1}` : null,
      })
    })
    if (!orders.length) return { kind: 'invalid', error: 'invalid_product' }
    return { kind: 'orders', orders }
  }

  // Session à un seul article (achat direct ou session antérieure au panier).
  const productSlug = String(metadata.product_slug ?? '').trim()
  if (!isValidSlug(productSlug)) return { kind: 'invalid', error: 'invalid_product' }

  const rawAmount = Number(session.amount_total)
  const amountCents = Number.isFinite(rawAmount) && rawAmount >= 0 ? Math.round(rawAmount) : null
  const rawName = String(metadata.product_name ?? '').trim()

  return {
    kind: 'orders',
    orders: [
      {
        orderId,
        email,
        productSlug,
        productName: rawName ? rawName.slice(0, 120) : null,
        amountCents,
        currency,
        paidAt,
        paymentRef: paymentRefBase,
      },
    ],
  }
}
