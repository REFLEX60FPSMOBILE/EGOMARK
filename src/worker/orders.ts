// Enregistrement idempotent d'une commande payée, commun à tous les
// prestataires. Une seule ligne par commande, une seule par paiement.

import { sameSecret } from './reviews'

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

export type RecordOutcome = 'created' | 'duplicate' | 'conflict' | 'payment_ref_taken'

export async function recordPaidOrder(
  db: D1Database,
  input: { order: PaidOrder; emailHash: string; source: string },
): Promise<RecordOutcome> {
  const { order, emailHash, source } = input

  let changes = 0
  try {
    const result = await db
      .prepare(
        "INSERT INTO orders (order_id, email_hash, product_slug, product_name, amount_cents, currency, paid_at, payment_ref, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(order_id) DO NOTHING",
      )
      .bind(
        order.orderId,
        emailHash,
        order.productSlug,
        order.productName,
        order.amountCents,
        order.currency,
        order.paidAt,
        order.paymentRef,
        source,
      )
      .run()
    changes = result.meta.changes ?? 0
  } catch {
    // Index unique sur payment_ref : ce paiement est déjà rattaché à une commande.
    return 'payment_ref_taken'
  }

  if (changes) return 'created'

  // Rejeu du prestataire : on n'acquitte que si c'est exactement la même commande.
  const existing = await db
    .prepare('SELECT email_hash, product_slug, payment_ref FROM orders WHERE order_id = ?1')
    .bind(order.orderId)
    .first<{ email_hash: string; product_slug: string; payment_ref: string | null }>()

  if (!existing) return 'conflict'

  const sameEmail = sameSecret(emailHash, existing.email_hash)
  const sameProduct = existing.product_slug === order.productSlug
  const sameRef = !order.paymentRef || !existing.payment_ref || existing.payment_ref === order.paymentRef
  return sameEmail && sameProduct && sameRef ? 'duplicate' : 'conflict'
}
