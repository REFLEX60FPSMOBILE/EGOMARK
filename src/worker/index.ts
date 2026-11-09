import { Hono, type Context } from 'hono'
import { PRICES } from './prices'
import { recordPaidOrder } from './orders'
import { parseCart, type CartItem } from './cart'
import {
  WEBHOOK_BODY_MAX as STRIPE_BODY_MAX,
  createCheckoutSession,
  isStripeConfigured,
  newOrderId,
  parseCheckoutCompleted,
  verifyStripeSignature,
} from './stripe'
import {
  WEBHOOK_BODY_MAX as PAYPAL_BODY_MAX,
  buildPayPalMeUrl,
  capturePayPalOrder,
  createPayPalOrder,
  fetchPayPalOrder,
  isPayPalConfigured,
  parsePayPalEvent,
  parsePayPalOrder,
  verifyPayPalWebhook,
} from './paypal'
import {
  REVIEW_AUTHOR_MAX,
  REVIEW_AUTHOR_MIN,
  REVIEW_BODY_MAX,
  REVIEW_BODY_MIN,
  cleanText,
  clientIp,
  hashSecret,
  isRateLimited,
  isValidEmail,
  isValidOrderId,
  isValidSlug,
  sameSecret,
} from './reviews'

// The Worker in front of the static site. Add API routes here; everything
// else falls through to the built assets (single-page-application mode).
type Env = {
  ASSETS: Fetcher
  DB?: D1Database
  ADMIN_TOKEN?: string
  REVIEW_SALT?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
  PAYPAL_ENV?: string
  PAYPAL_ME_HANDLE?: string
  SITE_ORIGIN?: string
}

const app = new Hono<{ Bindings: Env }>()

// Salt de développement. En production, définir le secret REVIEW_SALT.
const SALT_FALLBACK = 'ego-reviews-local-salt'
const saltOf = (env: Env) => env.REVIEW_SALT || SALT_FALLBACK

// Origine publique utilisée pour les retours de paiement.
const originOf = (c: Context<{ Bindings: Env }>) =>
  (c.env.SITE_ORIGIN || new URL(c.req.url).origin).replace(/\/+$/, '')

type SummaryRow = { count?: number | null; average?: number | null }
type ReviewRow = {
  id: string
  author: string
  rating: number
  body: string
  product_slug: string
  product_name: string | null
  created_at: string
}

app.get('/api/health', (c) => c.json({ ok: true }))

// Barème public : utilisé uniquement pour l'affichage du panier. Le montant
// facturé est recalculé côté serveur au moment du checkout.
app.get('/api/prices', (c) => c.json({ ok: true, prices: PRICES }))

// Newsletter / waitlist capture. Wire this to your email provider or a D1
// table; it currently just acknowledges the address.
app.post('/api/subscribe', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string })
  const email = body.email?.trim() ?? ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address.' }, 400)
  }
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- avis publics

app.get('/api/reviews', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)

  const product = (c.req.query('product') ?? '').trim()
  const parsedLimit = Number.parseInt(c.req.query('limit') ?? '24', 10)
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 24

  const summaryStmt = product
    ? db
        .prepare(
          "SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE status = 'published' AND product_slug = ?1",
        )
        .bind(product)
    : db.prepare("SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE status = 'published'")

  const listStmt = product
    ? db
        .prepare(
          "SELECT id, author, rating, body, product_slug, product_name, created_at FROM reviews WHERE status = 'published' AND product_slug = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .bind(product, limit)
    : db
        .prepare(
          "SELECT id, author, rating, body, product_slug, product_name, created_at FROM reviews WHERE status = 'published' ORDER BY created_at DESC LIMIT ?1",
        )
        .bind(limit)

  const [summaryResult, listResult] = await db.batch([summaryStmt, listStmt])
  const summaryRow = (summaryResult.results?.[0] ?? {}) as SummaryRow
  const rows = (listResult.results ?? []) as ReviewRow[]

  return c.json({
    ok: true,
    summary: {
      count: Number(summaryRow.count ?? 0),
      average: summaryRow.average == null ? null : Math.round(Number(summaryRow.average) * 10) / 10,
    },
    reviews: rows.map((row) => ({
      id: row.id,
      author: row.author,
      rating: Number(row.rating),
      body: row.body,
      productSlug: row.product_slug,
      productName: row.product_name,
      createdAt: row.created_at,
    })),
  })
})

app.post('/api/reviews', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)

  const ip = clientIp(c.req.raw)
  if (isRateLimited(ip)) return c.json({ error: 'rate_limited' }, 429)

  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const orderId = typeof payload.orderId === 'string' ? payload.orderId.trim() : ''
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const author = cleanText(payload.author, REVIEW_AUTHOR_MIN, REVIEW_AUTHOR_MAX)
  const reviewBody = cleanText(payload.body, REVIEW_BODY_MIN, REVIEW_BODY_MAX)
  const rating = Number(payload.rating)

  if (!isValidOrderId(orderId)) return c.json({ error: 'invalid_order' }, 400)
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400)
  if (!author) return c.json({ error: 'invalid_author' }, 400)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return c.json({ error: 'invalid_rating' }, 400)
  if (!reviewBody) return c.json({ error: 'invalid_body' }, 400)

  const order = await db
    .prepare('SELECT order_id, email_hash, product_slug, product_name, reviewed_at FROM orders WHERE order_id = ?1')
    .bind(orderId)
    .first<{
      order_id: string
      email_hash: string
      product_slug: string
      product_name: string | null
      reviewed_at: string | null
    }>()

  // Commande inconnue et e-mail non concordant renvoient la même réponse :
  // impossible d'énumérer les numéros de commande.
  if (!order) return c.json({ error: 'order_unknown' }, 404)

  const emailHash = await hashSecret(email, saltOf(c.env))
  if (!sameSecret(emailHash, order.email_hash)) return c.json({ error: 'order_unknown' }, 404)
  if (order.reviewed_at) return c.json({ error: 'already_reviewed' }, 409)

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const ipHash = await hashSecret(ip, saltOf(c.env))

  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO reviews (id, order_id, product_slug, product_name, author, rating, body, status, created_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'published', ?8, ?9)",
        )
        .bind(id, order.order_id, order.product_slug, order.product_name, author, rating, reviewBody, createdAt, ipHash),
      db.prepare('UPDATE orders SET reviewed_at = ?1 WHERE order_id = ?2').bind(createdAt, order.order_id),
    ])
  } catch {
    // UNIQUE(order_id) : deux envois simultanés pour la même commande.
    return c.json({ error: 'already_reviewed' }, 409)
  }

  return c.json(
    {
      ok: true,
      review: {
        id,
        author,
        rating,
        body: reviewBody,
        productSlug: order.product_slug,
        productName: order.product_name,
        createdAt,
      },
    },
    201,
  )
})

// ---------------------------------------------------------------- paiement

// Crée une session de paiement hébergée (Stripe Checkout ou PayPal) pour un
// produit du catalogue. Le montant vient de `./prices` : jamais du navigateur.
app.post('/api/checkout', async (c) => {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const rawEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (rawEmail && !isValidEmail(rawEmail)) return c.json({ error: 'invalid_email' }, 400)

  const origin = originOf(c)
  const orderId = newOrderId()
  const provider = payload.provider === 'paypal' ? 'paypal' : 'stripe'

  // Panier (`items`) ou achat direct (`slug` + `quantity`).
  let items: CartItem[] = []
  if (Array.isArray(payload.items)) {
    const parsed = parseCart(payload.items)
    if (parsed.kind === 'error') {
      const status = parsed.error === 'unknown_product' ? 404 : 400
      return c.json({ error: parsed.error }, status)
    }
    items = parsed.items
  } else {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : ''
    if (!isValidSlug(slug)) return c.json({ error: 'invalid_product' }, 400)
    const entry = PRICES[slug]
    if (!entry) return c.json({ error: 'unknown_product' }, 404)
    const parsedQuantity = Number(payload.quantity ?? 1)
    const quantity = Number.isInteger(parsedQuantity) ? Math.min(Math.max(parsedQuantity, 1), 10) : 1
    items = [{ slug, quantity, name: entry.name, amountCents: entry.amountCents }]
  }

  const totalCents = items.reduce((sum, item) => sum + item.amountCents * item.quantity, 0)

  if (provider === 'paypal') {
    // Sans identifiants API PayPal, le paiement part directement sur le compte
    // PayPal.Me du vendeur : montant prérempli, référence de commande affichée.
    if (!isPayPalConfigured(c.env)) {
      return c.json({
        ok: true,
        provider,
        mode: 'paypal_me',
        orderId,
        url: buildPayPalMeUrl(c.env.PAYPAL_ME_HANDLE || '', totalCents),
        amountCents: totalCents,
        currency: 'EUR',
        amountLabel: `${(totalCents / 100).toFixed(2)} €`,
        items,
      })
    }
    // Orders v2 : une seule commande PayPal par paiement.
    if (items.length > 1) return c.json({ error: 'paypal_cart_unsupported' }, 409)
    const only = items[0]
    try {
      const session = await createPayPalOrder(c.env, {
        orderId,
        slug: only.slug,
        name: only.name,
        amountCents: only.amountCents,
        quantity: only.quantity,
        origin,
      })
      return c.json({ ok: true, orderId, provider, url: session.url })
    } catch {
      return c.json({ error: 'checkout_failed' }, 502)
    }
  }

  if (!isStripeConfigured(c.env)) return c.json({ error: 'checkout_unavailable' }, 503)

  try {
    const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY as string, {
      orderId,
      items,
      origin,
      email: rawEmail || undefined,
    })
    return c.json({ ok: true, orderId, provider, url: session.url, itemCount: items.length })
  } catch {
    return c.json({ error: 'checkout_failed' }, 502)
  }
})

// Webhook Stripe : après un paiement réellement encaissé, la commande est
// enregistrée et ouvre immédiatement le droit à un avis vérifié.
app.post('/api/payments/webhook', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)

  const secret = c.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return c.json({ error: 'payments_not_configured' }, 503)

  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > STRIPE_BODY_MAX) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  const raw = await c.req.text()
  if (raw.length > STRIPE_BODY_MAX) return c.json({ error: 'payload_too_large' }, 413)

  // Signature Stripe sur le corps brut : un rejeu ancien ou un corps modifié
  // est refusé avant tout accès à la base.
  const signatureOk = await verifyStripeSignature({
    payload: raw,
    header: c.req.header('stripe-signature') ?? null,
    secret,
  })
  if (!signatureOk) return c.json({ error: 'invalid_signature' }, 401)

  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const parsed = parseCheckoutCompleted(event)
  if (parsed.kind === 'invalid') return c.json({ error: parsed.error }, 400)
  if (parsed.kind === 'ignored') return c.json({ ok: true, ignored: true, event: parsed.type })

  // Un panier crée une commande par article : chacune ouvre son propre droit à
  // un avis vérifié.
  const statuses: { orderId: string; outcome: string }[] = []
  for (const order of parsed.orders) {
    const emailHash = await hashSecret(order.email, saltOf(c.env))
    const outcome = await recordPaidOrder(db, { order, emailHash, source: 'stripe' })
    statuses.push({ orderId: order.orderId, outcome })
  }

  const conflict = statuses.find((entry) => entry.outcome === 'payment_ref_taken' || entry.outcome === 'conflict')
  if (conflict) {
    return c.json(
      { error: conflict.outcome === 'conflict' ? 'order_conflict' : 'payment_ref_exists', orders: statuses },
      409,
    )
  }

  const created = statuses.filter((entry) => entry.outcome === 'created')
  const orderIds = statuses.map((entry) => entry.orderId)
  if (created.length) {
    return c.json({ ok: true, orderId: orderIds[0], orderIds, reviewEligible: true, orders: statuses }, 201)
  }
  return c.json({ ok: true, duplicated: true, orderId: orderIds[0], orderIds, orders: statuses })
})

// Retour PayPal après approbation : la capture se fait côté serveur, puis la
// commande est enregistrée avant de renvoyer le client vers la page d'avis.
app.get('/api/payments/paypal/return', async (c) => {
  const origin = originOf(c)
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  if (!isPayPalConfigured(c.env)) return c.redirect(`${origin}/?payment=failed`, 302)

  const paypalOrderId = (c.req.query('token') ?? '').trim()
  if (!/^[A-Z0-9]{5,40}$/.test(paypalOrderId)) {
    return c.redirect(`${origin}/?payment=failed`, 302)
  }

  const captured = await capturePayPalOrder(c.env, paypalOrderId).catch(() => null)
  const order = parsePayPalOrder(captured)
  if (!order) return c.redirect(`${origin}/?payment=failed`, 302)

  const emailHash = await hashSecret(order.email, saltOf(c.env))
  const outcome = await recordPaidOrder(db, { order, emailHash, source: 'paypal' })

  if (outcome === 'payment_ref_taken') return c.redirect(`${origin}/?payment=conflict`, 302)
  if (outcome === 'conflict') return c.redirect(`${origin}/?payment=conflict`, 302)

  return c.redirect(`${origin}/reviews/?order=${encodeURIComponent(order.orderId)}`, 302)
})

// Webhook PayPal : signature vérifiée par PayPal lui-même. Sert de filet de
// sécurité si le client n'est pas revenu sur le site après son paiement.
app.post('/api/payments/paypal', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  if (!isPayPalConfigured(c.env) || !c.env.PAYPAL_WEBHOOK_ID) {
    return c.json({ error: 'paypal_unavailable' }, 503)
  }

  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > PAYPAL_BODY_MAX) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  const raw = await c.req.text()
  if (raw.length > PAYPAL_BODY_MAX) return c.json({ error: 'payload_too_large' }, 413)

  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const verified = await verifyPayPalWebhook(c.env, c.req.raw.headers, event).catch(() => false)
  if (!verified) return c.json({ error: 'invalid_signature' }, 401)

  const parsed = parsePayPalEvent(event)
  if (parsed.kind === 'invalid') return c.json({ error: parsed.error }, 400)
  if (parsed.kind === 'ignored') return c.json({ ok: true, ignored: true, event: parsed.type })
  if (!parsed.paypalOrderId) return c.json({ ok: true, ignored: true, event: parsed.type })

  const details = await fetchPayPalOrder(c.env, parsed.paypalOrderId).catch(() => null)
  const order = parsePayPalOrder(details)
  // E-mail absent ou paiement non capturé : rien à enregistrer, on acquitte.
  if (!order) return c.json({ ok: true, ignored: true, event: parsed.type })

  const emailHash = await hashSecret(order.email, saltOf(c.env))
  const outcome = await recordPaidOrder(db, { order, emailHash, source: 'paypal' })

  if (outcome === 'created') return c.json({ ok: true, orderId: order.orderId, reviewEligible: true }, 201)
  if (outcome === 'duplicate') return c.json({ ok: true, duplicated: true, orderId: order.orderId })
  if (outcome === 'payment_ref_taken') return c.json({ error: 'payment_ref_exists' }, 409)
  return c.json({ error: 'order_conflict' }, 409)
})

// ------------------------------------------------------------------- admin

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  order_id      TEXT PRIMARY KEY,
  email_hash    TEXT NOT NULL,
  product_slug  TEXT NOT NULL,
  product_name  TEXT,
  amount_cents  INTEGER,
  currency      TEXT,
  paid_at       TEXT NOT NULL,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payment_ref   TEXT,
  source        TEXT NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders (email_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_ref ON orders (payment_ref) WHERE payment_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE REFERENCES orders (order_id) ON DELETE CASCADE,
  product_slug  TEXT NOT NULL,
  product_name  TEXT,
  author        TEXT NOT NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at    TEXT NOT NULL,
  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_published ON reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews (product_slug, status);
`

const admin = new Hono<{ Bindings: Env }>()

admin.use('*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN
  if (!token) return c.json({ error: 'admin_not_configured' }, 503)
  const header = c.req.header('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '').trim()
  if (!provided || !sameSecret(provided, token)) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

// Initialise le schéma D1 d'une base neuve. Idempotent et protégé par
// ADMIN_TOKEN : à appeler une fois après le premier déploiement.
admin.post('/init', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  try {
    for (const statement of SCHEMA_SQL.split(';').map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
  } catch (error) {
    console.error('schema init failed', error)
    return c.json(
      { error: 'schema_failed', detail: error instanceof Error ? error.message : String(error) },
      500,
    )
  }
  return c.json({ ok: true })
})

// Enregistre une commande réellement payée hors flux Stripe/PayPal (secours).
admin.post('/orders', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)

  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const orderId = typeof payload.orderId === 'string' ? payload.orderId.trim() : ''
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const productSlug = typeof payload.productSlug === 'string' ? payload.productSlug.trim() : ''
  const productName =
    typeof payload.productName === 'string' && payload.productName.trim()
      ? payload.productName.trim().slice(0, 120)
      : null
  const amount = Number(payload.amountCents)
  const amountCents = Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null
  const currency =
    typeof payload.currency === 'string' && payload.currency.trim()
      ? payload.currency.trim().toUpperCase().slice(0, 3)
      : null
  const paidAtRaw = typeof payload.paidAt === 'string' ? Date.parse(payload.paidAt) : Number.NaN
  const paidAt = Number.isNaN(paidAtRaw) ? new Date().toISOString() : new Date(paidAtRaw).toISOString()

  if (!isValidOrderId(orderId)) return c.json({ error: 'invalid_order' }, 400)
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400)
  if (!isValidSlug(productSlug)) return c.json({ error: 'invalid_product' }, 400)

  const emailHash = await hashSecret(email, saltOf(c.env))

  try {
    await db
      .prepare(
        'INSERT INTO orders (order_id, email_hash, product_slug, product_name, amount_cents, currency, paid_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(orderId, emailHash, productSlug, productName, amountCents, currency, paidAt)
      .run()
  } catch {
    return c.json({ error: 'order_exists' }, 409)
  }

  return c.json({ ok: true, order: { orderId, productSlug, productName, paidAt } }, 201)
})

admin.get('/orders', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  const { results } = await db
    .prepare(
      'SELECT order_id, product_slug, product_name, amount_cents, currency, paid_at, reviewed_at, created_at FROM orders ORDER BY created_at DESC LIMIT 100',
    )
    .all()
  return c.json({ ok: true, orders: results ?? [] })
})

admin.get('/reviews', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  const status = c.req.query('status')
  const statement =
    status === 'published' || status === 'hidden'
      ? db
          .prepare(
            'SELECT id, order_id, author, rating, body, product_slug, product_name, status, created_at FROM reviews WHERE status = ?1 ORDER BY created_at DESC LIMIT 100',
          )
          .bind(status)
      : db.prepare(
          'SELECT id, order_id, author, rating, body, product_slug, product_name, status, created_at FROM reviews ORDER BY created_at DESC LIMIT 100',
        )
  const { results } = await statement.all()
  return c.json({ ok: true, reviews: results ?? [] })
})

const setReviewStatus = async (c: Context<{ Bindings: Env }>, status: 'hidden' | 'published') => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'reviews_unavailable' }, 503)
  const id = c.req.param('id')
  const result = await db.prepare('UPDATE reviews SET status = ?1 WHERE id = ?2').bind(status, id).run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, id, status })
}

admin.post('/reviews/:id/hide', (c) => setReviewStatus(c, 'hidden'))
admin.post('/reviews/:id/restore', (c) => setReviewStatus(c, 'published'))

app.route('/api/admin', admin)

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
