import { PRICES, type PriceEntry } from './prices'

export type PackOffer = {
  slug: string
  sourceSlug: string
  name: string
  quantity: number
  unitCents: number
  subtotalCents: number
  amountCents: number
  savingsCents: number
  discountPercent: number
}

// Pack pilote : trois liens cadeaux Nitro. Le prix est calculé depuis le prix
// unitaire serveur, avec 10 % de remise. Il n'y a aucun prix barré fictif.
const SOURCE_SLUG = 'nitro-boost-gift-link'
const QUANTITY = 3
const DISCOUNT_PERCENT = 10
const unitCents = PRICES[SOURCE_SLUG]?.amountCents ?? 259
const subtotalCents = unitCents * QUANTITY
const amountCents = Math.max(1, Math.round(subtotalCents * (1 - DISCOUNT_PERCENT / 100)))
const packSlug = `${SOURCE_SLUG}-pack-3`

export const PACK_OFFERS: Record<string, PackOffer> = {
  [SOURCE_SLUG]: {
    slug: packSlug,
    sourceSlug: SOURCE_SLUG,
    name: 'Nitro Boost Gift Link — Pack de 3',
    quantity: QUANTITY,
    unitCents,
    subtotalCents,
    amountCents,
    savingsCents: subtotalCents - amountCents,
    discountPercent: DISCOUNT_PERCENT,
  },
}

export const PACK_PRICES: Record<string, PriceEntry> = {
  [packSlug]: {
    name: PACK_OFFERS[SOURCE_SLUG].name,
    amountCents,
  },
}
