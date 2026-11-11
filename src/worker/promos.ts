// Codes promo : le code, le pourcentage et le nombre d'utilisations sont
// toujours vérifiés en base. Le navigateur ne peut jamais imposer un montant.
export type PromoRow = {
  code: string
  percent_off: number
  amount_off_cents: number
  min_total_cents: number
  max_uses: number | null
  uses: number
  active: number
  expires_at: string | null
}

export type Promo = {
  code: string
  percentOff: number
  amountOffCents: number
  discountCents: number
  subtotalCents: number
  totalCents: number
  label: string
}

export type PromoResult =
  | { kind: 'none' }
  | { kind: 'ok'; promo: Promo }
  | { kind: 'error'; error: string }

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/

export function normalizePromoCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return CODE_RE.test(code) ? code : null
}

export async function resolvePromo(
  db: D1Database | undefined,
  rawCode: unknown,
  subtotalCents: number,
): Promise<PromoResult> {
  const raw = typeof rawCode === 'string' ? rawCode.trim() : ''
  if (!raw) return { kind: 'none' }

  const code = normalizePromoCode(raw)
  if (!code) return { kind: 'error', error: 'promo_invalid' }
  if (!db) return { kind: 'error', error: 'promo_unavailable' }

  const row = await db
    .prepare(
      'SELECT code, percent_off, amount_off_cents, min_total_cents, max_uses, uses, active, expires_at FROM promo_codes WHERE code = ?1',
    )
    .bind(code)
    .first<PromoRow>()

  if (!row || Number(row.active) !== 1) return { kind: 'error', error: 'promo_invalid' }
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { kind: 'error', error: 'promo_expired' }
  }
  if (row.max_uses != null && Number(row.uses) >= Number(row.max_uses)) {
    return { kind: 'error', error: 'promo_exhausted' }
  }
  if (subtotalCents < Number(row.min_total_cents || 0)) {
    return { kind: 'error', error: 'promo_minimum' }
  }

  const percentOff = Number(row.percent_off) || 0
  const amountOffCents = Number(row.amount_off_cents) || 0
  const rawDiscount = amountOffCents + Math.round((subtotalCents * percentOff) / 100)
  const discountCents = Math.min(subtotalCents, Math.max(0, rawDiscount))
  if (discountCents <= 0) return { kind: 'error', error: 'promo_invalid' }

  const totalCents = Math.max(0, subtotalCents - discountCents)
  const label =
    percentOff > 0
      ? `${percentOff} % de remise`
      : `${(amountOffCents / 100).toFixed(2).replace('.', ',')} € de remise`

  return {
    kind: 'ok',
    promo: {
      code,
      percentOff,
      amountOffCents,
      discountCents,
      subtotalCents,
      totalCents,
      label,
    },
  }
}

// Réservation atomique : deux commandes simultanées ne peuvent pas dépasser
// max_uses. En cas d'échec de l'insertion de commande, l'usage est rendu.
export async function reservePromoUse(db: D1Database, code: string): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE promo_codes SET uses = uses + 1 WHERE code = ?1 AND active = 1 AND (max_uses IS NULL OR uses < max_uses)',
    )
    .bind(code)
    .run()
  return Boolean(result.meta.changes)
}

export async function releasePromoUse(db: D1Database, code: string): Promise<void> {
  await db.prepare('UPDATE promo_codes SET uses = MAX(uses - 1, 0) WHERE code = ?1').bind(code).run()
}
