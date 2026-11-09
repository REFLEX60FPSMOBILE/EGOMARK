// Intégration PayPal (Orders v2) : paiement hébergé, capture serveur et
// vérification du webhook par l'API PayPal.
//
// Flux : POST /v2/checkout/orders (intent CAPTURE) → redirection vers la page
// PayPal → retour sur /api/payments/paypal/return → capture serveur → commande
// enregistrée. Le webhook PAYMENT.CAPTURE.COMPLETED sert de filet de sécurité.

import type { PaidOrder } from './orders'
import { isValidEmail, isValidOrderId, isValidSlug } from './reviews'

export const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com'
export const PAYPAL_LIVE = 'https://api-m.paypal.com'
export const WEBHOOK_BODY_MAX = 64 * 1024

type PayPalEnv = {
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
  PAYPAL_ENV?: string
}

export function isPayPalConfigured(env: PayPalEnv): boolean {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)
}

export function paypalBase(env: PayPalEnv): string {
  return env.PAYPAL_ENV === 'live' ? PAYPAL_LIVE : PAYPAL_SANDBOX
}

export async function paypalAccessToken(env: PayPalEnv): Promise<string> {
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)
  const response = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!response.ok) throw new Error(`paypal_token_${response.status}`)
  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('paypal_token_missing')
  return data.access_token
}

const money = (cents: number, quantity: number): string => ((cents * quantity) / 100).toFixed(2)

export async function createPayPalOrder(
  env: PayPalEnv,
  input: { orderId: string; slug: string; name: string; amountCents: number; quantity: number; origin: string },
): Promise<{ id: string; url: string }> {
  const token = await paypalAccessToken(env)

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: input.slug,
        custom_id: input.orderId,
        invoice_id: input.orderId,
        description: `${input.name} x${input.quantity}`.slice(0, 127),
        amount: { currency_code: 'EUR', value: money(input.amountCents, input.quantity) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          landing_page: 'LOGIN',
          return_url: `${input.origin}/api/payments/paypal/return`,
          cancel_url: `${input.origin}/product/${input.slug}/`,
        },
      },
    },
  }

  const response = await fetch(`${paypalBase(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'paypal-request-id': input.orderId,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`paypal_order_${response.status}`)

  const data = (await response.json()) as { id?: string; links?: { href?: string; rel?: string }[] }
  const link = (data.links ?? []).find((entry) => entry.rel === 'payer-action' || entry.rel === 'approve')
  if (!data.id || !link || !link.href) throw new Error('paypal_order_missing_link')

  return { id: data.id, url: link.href }
}

type PayPalOrderJson = {
  id?: string
  status?: string
  payer?: { email_address?: string }
  purchase_units?: {
    reference_id?: string
    custom_id?: string
    invoice_id?: string
    description?: string
    payments?: { captures?: { id?: string; custom_id?: string; invoice_id?: string; amount?: { value?: string; currency_code?: string }; create_time?: string }[] }
  }[]
}

// Normalise une commande PayPal capturée. Renvoie null tant que l'argent n'est
// pas effectivement encaissé (statut différent de COMPLETED) ou si l'e-mail
// de l'acheteur manque : sans lui, aucun avis vérifié n'est possible.
export function parsePayPalOrder(order: PayPalOrderJson | null | undefined): PaidOrder | null {
  if (!order || order.status !== 'COMPLETED') return null

  const unit = order.purchase_units?.[0]
  const capture = unit?.payments?.captures?.[0]
  if (!unit || !capture) return null

  const orderId = String(capture.custom_id ?? unit.custom_id ?? capture.invoice_id ?? unit.invoice_id ?? '').trim()
  const email = String(order.payer?.email_address ?? '').trim().toLowerCase()
  const productSlug = String(unit.reference_id ?? '').trim()

  if (!isValidOrderId(orderId)) return null
  if (!isValidEmail(email)) return null
  if (!isValidSlug(productSlug)) return null

  const amount = Number(capture.amount?.value)
  const amountCents = Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null
  const rawCurrency = String(capture.amount?.currency_code ?? 'EUR').trim().toUpperCase()
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'EUR'

  const created = typeof capture.create_time === 'string' ? Date.parse(capture.create_time) : Number.NaN
  const paidAt = Number.isNaN(created) ? new Date().toISOString() : new Date(created).toISOString()

  const name = typeof unit.description === 'string' ? unit.description.replace(/\s+x\d+$/, '').trim() : ''
  const paymentRef = String(capture.id ?? '').trim().slice(0, 120) || null

  return {
    orderId,
    email,
    productSlug,
    productName: name ? name.slice(0, 120) : null,
    amountCents,
    currency,
    paidAt,
    paymentRef,
  }
}

export async function capturePayPalOrder(env: PayPalEnv, paypalOrderId: string): Promise<PayPalOrderJson | null> {
  const token = await paypalAccessToken(env)
  const response = await fetch(
    `${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'paypal-request-id': `capture-${paypalOrderId}`,
      },
      body: '{}',
    },
  )
  if (!response.ok) return null
  return (await response.json()) as PayPalOrderJson
}

export async function fetchPayPalOrder(env: PayPalEnv, paypalOrderId: string): Promise<PayPalOrderJson | null> {
  const token = await paypalAccessToken(env)
  const response = await fetch(
    `${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!response.ok) return null
  return (await response.json()) as PayPalOrderJson
}

// Vérification serveur-à-serveur, exigée par PayPal : la signature ne peut pas
// être recalculée localement, PayPal valide l'événement lui-même.
export async function verifyPayPalWebhook(
  env: PayPalEnv,
  headers: Headers,
  event: unknown,
): Promise<boolean> {
  const webhookId = env.PAYPAL_WEBHOOK_ID
  if (!webhookId) return false

  const token = await paypalAccessToken(env)
  const response = await fetch(`${paypalBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_time: headers.get('paypal-transmission-time'),
      cert_url: headers.get('paypal-cert-url'),
      auth_algo: headers.get('paypal-auth-algo'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      webhook_id: webhookId,
      webhook_event: event,
    }),
  })
  if (!response.ok) return false

  const data = (await response.json()) as { verification_status?: string }
  return data.verification_status === 'SUCCESS'
}

// Lien PayPal.Me : encaissement direct sur le compte du vendeur, sans API ni
// webhook. Le montant est prérempli dans la devise du catalogue.
export const PAYPAL_ME_DEFAULT_HANDLE = 'EGOMarket265'

export function buildPayPalMeUrl(handle: string, amountCents: number, currency = 'EUR'): string {
  const safeHandle = handle.replace(/[^A-Za-z0-9]/g, '') || PAYPAL_ME_DEFAULT_HANDLE
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'EUR'
  const amount = (Math.max(0, Math.round(amountCents)) / 100).toFixed(2)
  return `https://www.paypal.me/${safeHandle}/${amount}${safeCurrency}`
}

export type ParsedPayPalEvent =
  | { kind: 'ignored'; type: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'capture'; type: string; paypalOrderId: string | null }

export function parsePayPalEvent(event: unknown): ParsedPayPalEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { kind: 'invalid', error: 'invalid_event' }
  }

  const record = event as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!type) return { kind: 'invalid', error: 'invalid_event' }
  if (type !== 'PAYMENT.CAPTURE.COMPLETED') return { kind: 'ignored', type }

  const resource = record.resource && typeof record.resource === 'object' ? (record.resource as Record<string, unknown>) : {}
  const supplementary =
    resource.supplementary_data && typeof resource.supplementary_data === 'object'
      ? (resource.supplementary_data as Record<string, unknown>)
      : {}
  const related =
    supplementary.related_ids && typeof supplementary.related_ids === 'object'
      ? (supplementary.related_ids as Record<string, unknown>)
      : {}

  const paypalOrderId = String(related.order_id ?? '').trim() || null
  return { kind: 'capture', type, paypalOrderId }
}
