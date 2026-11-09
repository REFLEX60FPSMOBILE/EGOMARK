// Panier : validation et total côté serveur. Les prix viennent du catalogue
// (`prices.ts`), jamais du navigateur. Un panier est une liste `{slug, quantity}`
// fusionnée par produit, bornée pour éviter les abus.

import { PRICES } from './prices'

export const CART_MAX_ITEMS = 10
export const CART_MAX_QUANTITY = 10

export type CartItem = {
  slug: string
  quantity: number
  name: string
  amountCents: number
}

export type CartResult =
  | { kind: 'ok'; items: CartItem[]; totalCents: number }
  | { kind: 'error'; error: string }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export function parseCart(raw: unknown): CartResult {
  if (!Array.isArray(raw) || raw.length === 0) return { kind: 'error', error: 'invalid_cart' }
  if (raw.length > CART_MAX_ITEMS) return { kind: 'error', error: 'cart_too_large' }

  const merged = new Map<string, number>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'error', error: 'invalid_cart' }
    }
    const row = entry as Record<string, unknown>
    const slug = typeof row.slug === 'string' ? row.slug.trim() : ''
    if (!SLUG_RE.test(slug)) return { kind: 'error', error: 'invalid_product' }

    const parsed = Number(row.quantity ?? 1)
    const quantity = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), CART_MAX_QUANTITY) : 1
    merged.set(slug, Math.min((merged.get(slug) ?? 0) + quantity, CART_MAX_QUANTITY))
  }

  if (merged.size > CART_MAX_ITEMS) return { kind: 'error', error: 'cart_too_large' }

  const items: CartItem[] = []
  let totalCents = 0
  for (const [slug, quantity] of merged) {
    const entry = PRICES[slug]
    if (!entry) return { kind: 'error', error: 'unknown_product' }
    items.push({ slug, quantity, name: entry.name, amountCents: entry.amountCents })
    totalCents += entry.amountCents * quantity
  }

  return { kind: 'ok', items, totalCents }
}
