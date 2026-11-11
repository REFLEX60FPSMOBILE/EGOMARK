import { Hono, type Context } from 'hono'
import { PRICES } from './prices'
import { recordPaidOrder } from './orders'
import { parseCart, type CartItem } from './cart'
import { notifyDiscordOrder, notifyDiscordTicket } from './discord'
import { PACK_OFFERS, PACK_PRICES } from './packs'
import { normalizePromoCode, releasePromoUse, reservePromoUse, resolvePromo } from './promos'
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
import {
  clearSessionCookie,
  createClientSession,
  getClientSession,
  hashEmail,
  hashPassword,
  isSameOriginRequest,
  isStrongEnoughPassword,
  maskEmail,
  newTotpSecret,
  normalizeEmail,
  otpauthUrl,
  parseCookies,
  randomHex,
  recordClientLogin,
  sessionCookie,
  verifyPassword,
  verifyTotp,
} from './accounts'
import { buildInvoicePdf } from './invoice'

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
  DISCORD_WEBHOOK_URL?: string
  DISCORD_CLIENT_ID?: string
  DISCORD_CLIENT_SECRET?: string
  DISCORD_REDIRECT_URI?: string
}

type StaffActor = {
  id: string
  name: string
  role: 'admin' | 'support' | 'logistics'
  via: 'owner' | 'staff'
}

type AppEnv = { Bindings: Env; Variables: { staff: StaffActor } }

const app = new Hono<AppEnv>()

// Salt de développement. En production, définir le secret REVIEW_SALT.
const SALT_FALLBACK = 'ego-reviews-local-salt'
const saltOf = (env: Env) => env.REVIEW_SALT || SALT_FALLBACK

// Origine publique utilisée pour les retours de paiement.
const originOf = (c: Context<AppEnv>) =>
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
app.get('/api/prices', (c) =>
  c.json({ ok: true, prices: { ...PRICES, ...PACK_PRICES }, packs: PACK_OFFERS }),
)

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

// ------------------------------------------- commande PayPal manuelle

// La boutique ne prend plus les cartes : le client paie sur PayPal.Me, puis
// enregistre son ID de transaction et son pseudo Discord. Le vendeur vérifie
// le paiement et livre manuellement sur Discord.
const DISCORD_MAX = 32
const PAYPAL_REF_RE = /^[A-Za-z0-9-]{6,64}$/

function normalizeDiscord(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().replace(/^@+/, '').replace(/\s+/g, ' ')
  if (Array.from(cleaned).length < 2 || Array.from(cleaned).length > DISCORD_MAX) return null
  if (/[<>\u0000-\u001f\u007f]/.test(cleaned)) return null
  return cleaned
}

function cleanOrderNote(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500)
  return cleaned || null
}

// Jeton de suivi client : dérivé de l'identifiant de commande et du sel serveur,
// donc sans colonne ni migration. Il n'est renvoyé qu'à la création (et après
// vérification de la référence PayPal) et reste stocké dans le navigateur.
const CLIENT_TOKEN_RE = /^[0-9a-f]{64}$/

async function clientOrderToken(env: Env, orderId: string): Promise<string> {
  return hashSecret(`client-order:${orderId}`, saltOf(env))
}

app.post('/api/orders/manual/link', async (c) => {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const parsed = parseCart(payload.items)
  if (parsed.kind === 'error') {
    return c.json({ error: parsed.error }, parsed.error === 'unknown_product' ? 404 : 400)
  }

  const promo = await resolvePromo(c.env.DB, payload.promoCode, parsed.totalCents)
  if (promo.kind === 'error') {
    return c.json(
      { error: promo.error },
      promo.error === 'promo_unavailable' ? 503 : promo.error === 'promo_exhausted' ? 409 : 400,
    )
  }
  const subtotalCents = parsed.totalCents
  const discountCents = promo.kind === 'ok' ? promo.promo.discountCents : 0
  const totalCents = promo.kind === 'ok' ? promo.promo.totalCents : subtotalCents

  return c.json({
    ok: true,
    provider: 'paypal_manual',
    url: buildPayPalMeUrl(c.env.PAYPAL_ME_HANDLE || '', totalCents),
    subtotalCents,
    discountCents,
    totalCents,
    amountCents: totalCents,
    currency: 'EUR',
    amountLabel: `${(totalCents / 100).toFixed(2)} €`,
    promo: promo.kind === 'ok' ? { code: promo.promo.code, label: promo.promo.label } : null,
    items: parsed.items,
  })
})

app.post('/api/orders/manual', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)

  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const discord = normalizeDiscord(payload.discord)
  if (!discord) return c.json({ error: 'invalid_discord' }, 400)

  const paypalRef = typeof payload.paypalRef === 'string' ? payload.paypalRef.trim().toUpperCase() : ''
  if (!PAYPAL_REF_RE.test(paypalRef)) return c.json({ error: 'invalid_paypal_ref' }, 400)

  const parsed = parseCart(payload.items)
  if (parsed.kind === 'error') {
    return c.json({ error: parsed.error }, parsed.error === 'unknown_product' ? 404 : 400)
  }

  const promo = await resolvePromo(db, payload.promoCode, parsed.totalCents)
  if (promo.kind === 'error') {
    return c.json(
      { error: promo.error },
      promo.error === 'promo_unavailable' ? 503 : promo.error === 'promo_exhausted' ? 409 : 400,
    )
  }

  const subtotalCents = parsed.totalCents
  const discountCents = promo.kind === 'ok' ? promo.promo.discountCents : 0
  const totalCents = promo.kind === 'ok' ? promo.promo.totalCents : subtotalCents
  const note = cleanOrderNote(payload.note)
  const ip = clientIp(c.req.raw)
  if (await blacklistBlocked(db, c.env, { ip, discord, paypalRef })) {
    return c.json({ error: 'blocked' }, 403)
  }
  const existing = await db.prepare('SELECT order_id FROM manual_orders WHERE paypal_ref = ?1').bind(paypalRef).first()
  if (existing) return c.json({ error: 'paypal_ref_exists' }, 409)

  let promoReserved = false
  if (promo.kind === 'ok') {
    promoReserved = await reservePromoUse(db, promo.promo.code)
    if (!promoReserved) return c.json({ error: 'promo_exhausted' }, 409)
  }

  const orderId = newOrderId()
  const createdAt = new Date().toISOString()
  try {
    const statements = [
      db
        .prepare(
        'INSERT INTO manual_orders (order_id, discord, paypal_ref, items_json, total_cents, currency, note, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
      )
        .bind(
          orderId,
          discord,
          paypalRef,
          JSON.stringify(parsed.items),
          totalCents,
          'EUR',
          note,
          'pending',
          createdAt,
          createdAt,
        ),
    ]
    if (promo.kind === 'ok') {
      statements.push(
        db
          .prepare('INSERT INTO promo_redemptions (order_id, code, discount_cents) VALUES (?1, ?2, ?3)')
          .bind(orderId, promo.promo.code, discountCents),
      )
    }
    statements.push(upsertWorkflowForNewOrder(db, orderId, createdAt), eventForNewOrder(db, orderId, createdAt))
    await db.batch(statements)
  } catch (error) {
    if (promoReserved && promo.kind === 'ok') {
      await releasePromoUse(db, promo.promo.code).catch(() => {})
    }
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('unique')) return c.json({ error: 'paypal_ref_exists' }, 409)
    console.error('manual order insert failed', error)
    return c.json({ error: 'manual_order_failed' }, 500)
  }

  // Notification best-effort : la commande est déjà enregistrée, un webhook
  // lent ou en échec ne change ni le statut ni la réponse.
  await notifyDiscordOrder(
    c.env,
    {
      orderId,
      discord,
      paypalRef,
      items: parsed.items,
      subtotalCents,
      discountCents,
      totalCents,
      promoCode: promo.kind === 'ok' ? promo.promo.code : null,
      note,
      createdAt,
    },
    `${originOf(c)}/admin/`,
  )

  const clientToken = await clientOrderToken(c.env, orderId)

  return c.json(
    {
      ok: true,
      order: {
        orderId,
        clientToken,
        discord,
        items: parsed.items,
        subtotalCents,
        discountCents,
        totalCents,
        currency: 'EUR',
        status: 'pending',
        promoCode: promo.kind === 'ok' ? promo.promo.code : null,
        createdAt,
      },
    },
    201,
  )
})

// Suivi client : le navigateur envoie les jetons qu'il détient, le serveur ne
// renvoie que les commandes correspondantes. Aucun pseudo ni e-mail ne suffit.
app.post('/api/client/orders', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'orders_unavailable' }, 503)

  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const rows = payload?.orders
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 50) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const ids: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    const orderId = typeof entry.orderId === 'string' ? entry.orderId.trim() : ''
    const token = typeof entry.token === 'string' ? entry.token.trim().toLowerCase() : ''
    if (!isValidOrderId(orderId) || !CLIENT_TOKEN_RE.test(token)) continue
    const expected = await clientOrderToken(c.env, orderId)
    if (sameSecret(token, expected)) ids.push(orderId)
  }
  if (!ids.length) return c.json({ ok: true, orders: [] })

  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT m.order_id, m.discord, m.items_json, m.total_cents, m.currency, m.status AS legacy_status,
              COALESCE(w.status, m.status) AS workflow_status, m.paypal_ref, m.created_at, m.updated_at,
              p.code AS promo_code, p.discount_cents
       FROM manual_orders m
       LEFT JOIN order_workflow w ON w.order_id = m.order_id
       LEFT JOIN promo_redemptions p ON p.order_id = m.order_id
       WHERE m.order_id IN (${placeholders})
       ORDER BY m.created_at DESC`,
    )
    .bind(...ids)
    .all()

  const [keyResult, ticketResult, eventResult] = await db.batch([
    db
      .prepare(
        `SELECT order_id, product_slug, id, secret, status, delivered_at FROM stock_keys
         WHERE order_id IN (${placeholders}) AND status = 'delivered' ORDER BY created_at ASC`,
      )
      .bind(...ids),
    db
      .prepare(
        `SELECT id, order_id, subject, status, priority, assignee, updated_at FROM support_tickets
         WHERE order_id IN (${placeholders}) ORDER BY updated_at DESC`,
      )
      .bind(...ids),
    db
      .prepare(
        `SELECT order_id, type, to_status, note, created_at FROM order_events
         WHERE order_id IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .bind(...ids),
  ])

  const groupByOrder = (rows: unknown[] | undefined) => {
    const grouped = new Map<string, Array<Record<string, unknown>>>()
    for (const row of rows ?? []) {
      if (!row || typeof row !== 'object') continue
      const value = row as Record<string, unknown>
      const orderId = typeof value.order_id === 'string' ? value.order_id : ''
      if (!orderId) continue
      const list = grouped.get(orderId) || []
      list.push(value)
      grouped.set(orderId, list)
    }
    return grouped
  }
  const keysByOrder = groupByOrder(keyResult.results)
  const ticketsByOrder = groupByOrder(ticketResult.results)
  const eventsByOrder = groupByOrder(eventResult.results)

  const orders = (results ?? []).map((row) => {
    const value = row as Record<string, unknown>
    const orderId = typeof value.order_id === 'string' ? value.order_id : ''
    const reference = typeof value.paypal_ref === 'string' ? value.paypal_ref : ''
    const copy = { ...value }
    delete copy.paypal_ref
    return {
      ...copy,
      paypal_ref_masked: reference ? `${reference.slice(0, 4)}••••${reference.slice(-4)}` : null,
      keys: keysByOrder.get(orderId) ?? [],
      tickets: ticketsByOrder.get(orderId) ?? [],
      events: eventsByOrder.get(orderId) ?? [],
    }
  })

  return c.json({ ok: true, orders })
})

// Retrouve une commande sur un autre appareil : il faut le numéro de commande
// ET la référence PayPal exacte. Limité par IP pour freiner les essais.
app.post('/api/client/claim', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'orders_unavailable' }, 503)
  if (isRateLimited(`client-claim:${clientIp(c.req.raw)}`)) {
    return c.json({ error: 'rate_limited' }, 429)
  }

  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const orderId = payload && typeof payload.orderId === 'string' ? payload.orderId.trim() : ''
  const paypalRef =
    payload && typeof payload.paypalRef === 'string' ? payload.paypalRef.trim().toUpperCase() : ''
  if (!isValidOrderId(orderId) || !PAYPAL_REF_RE.test(paypalRef)) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const found = await db
    .prepare('SELECT order_id FROM manual_orders WHERE order_id = ?1 AND paypal_ref = ?2')
    .bind(orderId, paypalRef)
    .first()
  if (!found) return c.json({ error: 'order_not_found' }, 404)

  return c.json({ ok: true, orderId, token: await clientOrderToken(c.env, orderId) })
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

// --------------------------------------------------------------- client console

const clientOrderAuth = async (
  c: Context,
  db: D1Database,
  orderId: string,
  token: string,
): Promise<boolean> => {
  if (isValidOrderId(orderId) && CLIENT_TOKEN_RE.test(token)) {
    const expected = await clientOrderToken(c.env, orderId)
    if (sameSecret(token, expected)) return true
  }
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return false
  const link = await db
    .prepare('SELECT 1 AS ok FROM client_order_links WHERE account_id = ?1 AND order_id = ?2')
    .bind(session.account.id, orderId)
    .first()
  return Boolean(link)
}

app.post('/api/client/orders/:id/paypal', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'orders_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const orderId = c.req.param('id')
  if (!isValidOrderId(orderId)) return c.json({ error: 'invalid_order' }, 400)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const token = typeof payload?.token === 'string' ? payload.token.trim().toLowerCase() : ''
  const paypalRef = typeof payload?.paypalRef === 'string' ? payload.paypalRef.trim().toUpperCase() : ''
  if (!PAYPAL_REF_RE.test(paypalRef)) return c.json({ error: 'invalid_paypal_ref' }, 400)
  if (!(await clientOrderAuth(c, db, orderId, token))) return c.json({ error: 'unauthorized' }, 401)
  if (isRateLimited(`order-paypal:${clientIp(c.req.raw)}`)) return c.json({ error: 'rate_limited' }, 429)

  const order = await db
    .prepare('SELECT paypal_ref, discord FROM manual_orders WHERE order_id = ?1')
    .bind(orderId)
    .first<{ paypal_ref: string | null; discord: string }>()
  if (!order) return c.json({ error: 'not_found' }, 404)
  if (order.paypal_ref) return c.json({ error: 'paypal_already_set' }, 409)
  if (await blacklistBlocked(db, c.env, { ip: clientIp(c.req.raw), discord: order.discord, paypalRef })) {
    return c.json({ error: 'blocked' }, 403)
  }
  const duplicate = await db
    .prepare('SELECT order_id FROM manual_orders WHERE paypal_ref = ?1 AND order_id <> ?2')
    .bind(paypalRef, orderId)
    .first()
  if (duplicate) return c.json({ error: 'paypal_ref_exists' }, 409)

  const now = nowIso()
  const result = await db
    .prepare('UPDATE manual_orders SET paypal_ref = ?1, updated_at = ?2 WHERE order_id = ?3 AND (paypal_ref IS NULL OR paypal_ref = \'\')')
    .bind(paypalRef, now, orderId)
    .run()
  if (!result.meta.changes) return c.json({ error: 'paypal_already_set' }, 409)
  await db
    .prepare(
      "INSERT INTO order_events (id, order_id, type, from_status, to_status, actor, note, created_at) VALUES (?1, ?2, 'paypal_ref', NULL, NULL, 'client', 'Référence PayPal ajoutée par le client', ?3)",
    )
    .bind(crypto.randomUUID(), orderId, now)
    .run()
  return c.json({
    ok: true,
    paypal_ref_masked: `${paypalRef.slice(0, 4)}••••${paypalRef.slice(-4)}`,
  })
})

app.get('/api/client/orders/:id/invoice', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'orders_unavailable' }, 503)
  const orderId = c.req.param('id')
  if (!isValidOrderId(orderId)) return c.json({ error: 'invalid_order' }, 400)
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim().toLowerCase()
  if (!(await clientOrderAuth(c, db, orderId, token))) return c.json({ error: 'unauthorized' }, 401)

  const order = await db
    .prepare(
      `SELECT m.*, COALESCE(w.status, m.status) AS workflow_status, p.code AS promo_code, p.discount_cents
       FROM manual_orders m LEFT JOIN order_workflow w ON w.order_id = m.order_id
       LEFT JOIN promo_redemptions p ON p.order_id = m.order_id
       WHERE m.order_id = ?1`,
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  if (!order) return c.json({ error: 'not_found' }, 404)

  const reference = typeof order.paypal_ref === 'string' ? order.paypal_ref : ''
  const discountCents = Number(order.discount_cents) || 0
  const totalCents = Number(order.total_cents) || 0
  const pdf = buildInvoicePdf({
    orderId,
    createdAt: String(order.created_at || new Date().toISOString()),
    discord: String(order.discord || ''),
    currency: String(order.currency || 'EUR'),
    items: parseOrderItems(order.items_json),
    subtotalCents: totalCents + discountCents,
    discountCents,
    totalCents,
    paypalMasked: reference ? `${reference.slice(0, 4)}••••${reference.slice(-4)}` : null,
    status: String(order.workflow_status || order.status || 'pending'),
    promoCode: typeof order.promo_code === 'string' ? order.promo_code : null,
  })
  return new Response(pdf.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="facture-${orderId}.pdf"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
})

app.post('/api/client/tickets', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)
  const orderId = typeof payload.orderId === 'string' ? payload.orderId.trim() : ''
  const token = typeof payload.token === 'string' ? payload.token.trim().toLowerCase() : ''
  const subject = cleanText(payload.subject, 3, 120)
  const message = cleanText(payload.message, 5, 4000)
  if (!isValidOrderId(orderId) || !subject || !message) return c.json({ error: 'invalid_ticket' }, 400)
  if (!(await clientOrderAuth(c, db, orderId, token))) return c.json({ error: 'unauthorized' }, 401)

  const order = await db
    .prepare('SELECT discord, paypal_ref FROM manual_orders WHERE order_id = ?1')
    .bind(orderId)
    .first<{ discord: string; paypal_ref: string }>()
  if (!order) return c.json({ error: 'not_found' }, 404)
  const ip = clientIp(c.req.raw)
  if (await blacklistBlocked(db, c.env, { ip, discord: order.discord, paypalRef: order.paypal_ref })) {
    return c.json({ error: 'blocked' }, 403)
  }
  if (isRateLimited(`client-ticket:${ip}`)) return c.json({ error: 'rate_limited' }, 429)

  const now = nowIso()
  const ticketId = crypto.randomUUID()
  await db.batch([
    db
      .prepare(
        "INSERT INTO support_tickets (id, order_id, discord, subject, status, priority, source, created_at, updated_at, last_message_at) VALUES (?1, ?2, ?3, ?4, 'open', 'normal', 'site', ?5, ?5, ?5)",
      )
      .bind(ticketId, orderId, order.discord, subject, now),
    db
      .prepare(
        "INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, created_at) VALUES (?1, ?2, 'client', ?3, ?4, ?5)",
      )
      .bind(crypto.randomUUID(), ticketId, order.discord, message, now),
  ])
  await notifyDiscordTicket(
    c.env,
    { ticketId, orderId, discord: order.discord, subject, message, createdAt: now },
    `${originOf(c)}/admin/`,
  )
  return c.json({ ok: true, ticket: { id: ticketId, orderId, subject, status: 'open', createdAt: now } }, 201)
})

app.post('/api/client/tickets/list', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const rows = Array.isArray(payload?.orders) ? payload.orders.slice(0, 50) : []
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    const orderId = typeof entry.orderId === 'string' ? entry.orderId.trim() : ''
    const token = typeof entry.token === 'string' ? entry.token.trim().toLowerCase() : ''
    if (!isValidOrderId(orderId) || !CLIENT_TOKEN_RE.test(token)) continue
    if (sameSecret(token, await clientOrderToken(c.env, orderId))) ids.add(orderId)
  }
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (session) {
    const { results } = await db
      .prepare('SELECT order_id FROM client_order_links WHERE account_id = ?1')
      .bind(session.account.id)
      .all()
    for (const row of results ?? []) {
      const value = (row as Record<string, unknown>).order_id
      if (typeof value === 'string') ids.add(value)
    }
  }
  if (!ids.size) return c.json({ ok: true, tickets: [] })
  const orderIds = [...ids]
  const placeholders = orderIds.map((_, index) => `?${index + 1}`).join(', ')
  const { results: ticketRows } = await db
    .prepare(
      `SELECT id, order_id, discord, subject, status, priority, assignee, created_at, updated_at, last_message_at
       FROM support_tickets WHERE order_id IN (${placeholders}) ORDER BY last_message_at DESC LIMIT 100`,
    )
    .bind(...orderIds)
    .all()
  const tickets = (ticketRows ?? []) as Array<Record<string, unknown>>
  if (!tickets.length) return c.json({ ok: true, tickets: [] })
  const ticketIds = tickets.map((ticket) => String(ticket.id))
  const messagePlaceholders = ticketIds.map((_, index) => `?${index + 1}`).join(', ')
  const { results: messages } = await db
    .prepare(
      `SELECT ticket_id, author_type, author_name, body, created_at FROM ticket_messages
       WHERE ticket_id IN (${messagePlaceholders}) ORDER BY created_at ASC LIMIT 500`,
    )
    .bind(...ticketIds)
    .all()
  const byTicket = new Map<string, Array<Record<string, unknown>>>()
  for (const row of messages ?? []) {
    const value = row as Record<string, unknown>
    const key = String(value.ticket_id)
    const list = byTicket.get(key) || []
    list.push(value)
    byTicket.set(key, list)
  }
  return c.json({
    ok: true,
    tickets: tickets.map((ticket) => ({ ...ticket, messages: byTicket.get(String(ticket.id)) ?? [] })),
  })
})

app.post('/api/client/tickets/:id/messages', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const orderId = typeof payload?.orderId === 'string' ? payload.orderId.trim() : ''
  const token = typeof payload?.token === 'string' ? payload.token.trim().toLowerCase() : ''
  const message = cleanText(payload?.message, 2, 4000)
  if (!isValidOrderId(orderId) || !message) return c.json({ error: 'invalid_message' }, 400)
  if (!(await clientOrderAuth(c, db, orderId, token))) return c.json({ error: 'unauthorized' }, 401)

  const ticket = await db
    .prepare('SELECT id, order_id, discord FROM support_tickets WHERE id = ?1 AND order_id = ?2')
    .bind(c.req.param('id'), orderId)
    .first<{ id: string; order_id: string; discord: string }>()
  if (!ticket) return c.json({ error: 'not_found' }, 404)
  const now = nowIso()
  const messageId = crypto.randomUUID()
  await db.batch([
    db
      .prepare(
        "INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, created_at) VALUES (?1, ?2, 'client', ?3, ?4, ?5)",
      )
      .bind(messageId, ticket.id, ticket.discord, message, now),
    db
      .prepare("UPDATE support_tickets SET status = 'open', updated_at = ?1, last_message_at = ?1 WHERE id = ?2")
      .bind(now, ticket.id),
  ])
  await notifyDiscordTicket(
    c.env,
    { ticketId: ticket.id, orderId, discord: ticket.discord, subject: 'Nouveau message client', message, createdAt: now },
    `${originOf(c)}/admin/`,
  )
  return c.json({ ok: true, message: { id: messageId, body: message, createdAt: now } }, 201)
})

// --------------------------------------------------------------- client auth

// --------------------------------------------------------------- Discord OAuth

const DISCORD_CLIENT_ID_FALLBACK = '1569665981691727902'
const DISCORD_OAUTH_SCOPES = 'identify email'
const DISCORD_OAUTH_STATE_COOKIE = 'ego_discord_oauth_state'

const discordRedirectUri = (c: Context<AppEnv>): string =>
  c.env.DISCORD_REDIRECT_URI?.trim() || `${originOf(c)}/auth/callback`

const discordAvatarUrl = (discordId: string, avatar: string | null): string => {
  if (!avatar) return 'https://cdn.discordapp.com/embed/avatars/0.png'
  const extension = avatar.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(avatar)}.${extension}?size=160`
}

const discordStateCookie = (state: string, request: Request): string => {
  const parts = [
    `${DISCORD_OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
  ]
  if (new URL(request.url).protocol === 'https:') parts.push('Secure')
  return parts.join('; ')
}

const clearDiscordStateCookie = (request: Request): string => {
  const parts = [
    `${DISCORD_OAUTH_STATE_COOKIE}=`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (new URL(request.url).protocol === 'https:') parts.push('Secure')
  return parts.join('; ')
}

const discordErrorRedirect = (c: Context<AppEnv>, reason: string) => {
  c.header('set-cookie', clearDiscordStateCookie(c.req.raw), { append: true })
  return c.redirect(`/?discord_error=${encodeURIComponent(reason)}`, 302)
}

app.get('/auth/discord', (c) => {
  const clientId = c.env.DISCORD_CLIENT_ID?.trim() || DISCORD_CLIENT_ID_FALLBACK
  if (!c.env.DISCORD_CLIENT_SECRET) return discordErrorRedirect(c, 'not_configured')

  const state = randomHex(24)
  const authorizeUrl = new URL('https://discord.com/oauth2/authorize')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', discordRedirectUri(c))
  authorizeUrl.searchParams.set('scope', DISCORD_OAUTH_SCOPES)
  authorizeUrl.searchParams.set('state', state)

  c.header('set-cookie', discordStateCookie(state, c.req.raw))
  return c.redirect(authorizeUrl.toString(), 302)
})

app.get('/auth/callback', async (c) => {
  const oauthError = c.req.query('error')
  if (oauthError) {
    return discordErrorRedirect(c, oauthError === 'access_denied' ? 'access_denied' : 'oauth_failed')
  }

  const code = c.req.query('code') || ''
  const state = c.req.query('state') || ''
  const expectedState = parseCookies(c.req.raw)[DISCORD_OAUTH_STATE_COOKIE] || ''
  if (!code || !state || !expectedState || !sameSecret(state, expectedState)) {
    return discordErrorRedirect(c, 'state_mismatch')
  }

  const clientId = c.env.DISCORD_CLIENT_ID?.trim() || DISCORD_CLIENT_ID_FALLBACK
  const clientSecret = c.env.DISCORD_CLIENT_SECRET
  const db = c.env.DB
  if (!clientSecret || !db) return discordErrorRedirect(c, 'not_configured')

  let accessToken = ''
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri(c),
    })
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    })
    const tokenPayload = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown } | null
    if (!tokenResponse.ok || typeof tokenPayload?.access_token !== 'string') {
      console.warn('discord oauth: token exchange failed', tokenResponse.status)
      return discordErrorRedirect(c, 'token_exchange_failed')
    }
    accessToken = tokenPayload.access_token
  } catch (error) {
    console.warn('discord oauth: token request unavailable', error instanceof Error ? error.message : 'unknown')
    return discordErrorRedirect(c, 'discord_unavailable')
  }

  let profile: Record<string, unknown>
  try {
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    })
    const userPayload = (await userResponse.json().catch(() => null)) as Record<string, unknown> | null
    if (!userResponse.ok || !userPayload || typeof userPayload.id !== 'string') {
      console.warn('discord oauth: profile request failed', userResponse.status)
      return discordErrorRedirect(c, 'user_fetch_failed')
    }
    profile = userPayload
  } catch (error) {
    console.warn('discord oauth: profile unavailable', error instanceof Error ? error.message : 'unknown')
    return discordErrorRedirect(c, 'discord_unavailable')
  }

  try {
    const discordId = String(profile.id)
    const username =
      typeof profile.username === 'string' && profile.username.trim()
        ? profile.username.trim().slice(0, 64)
        : 'discord'
    const displayName =
      typeof profile.global_name === 'string' && profile.global_name.trim()
        ? profile.global_name.trim().slice(0, 80)
        : username
    const avatar = typeof profile.avatar === 'string' && profile.avatar ? profile.avatar.slice(0, 128) : null
    const avatarUrl = discordAvatarUrl(discordId, avatar)
    const email = profile.verified === true ? normalizeEmail(profile.email) : null
    const emailMasked = email ? maskEmail(email) : `@${username}`
    const salt = saltOf(c.env)
    const now = new Date().toISOString()
    const ipHash = await hashSecret(clientIp(c.req.raw), salt)

    const existingIdentity = await db
      .prepare('SELECT account_id FROM discord_identities WHERE discord_id = ?1')
      .bind(discordId)
      .first<{ account_id: string }>()
    let accountId = existingIdentity?.account_id || ''

    if (!accountId) {
      const emailHash = email
        ? await hashEmail(email, salt)
        : await hashEmail(`${discordId}@discord.invalid`, salt)
      const emailAccount = await db
        .prepare('SELECT id FROM client_accounts WHERE email_hash = ?1')
        .bind(emailHash)
        .first<{ id: string }>()

      if (emailAccount) {
        const linkedIdentity = await db
          .prepare('SELECT discord_id FROM discord_identities WHERE account_id = ?1')
          .bind(emailAccount.id)
          .first<{ discord_id: string }>()
        if (linkedIdentity && linkedIdentity.discord_id !== discordId) {
          return discordErrorRedirect(c, 'discord_already_linked')
        }
        accountId = emailAccount.id
      } else {
        accountId = crypto.randomUUID()
        const randomPassword = await hashPassword(randomHex(32))
        await db
          .prepare(
            'INSERT INTO client_accounts (id, email_hash, email_masked, password_hash, password_salt, password_iterations, totp_enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)',
          )
          .bind(
            accountId,
            emailHash,
            emailMasked,
            randomPassword.hash,
            randomPassword.salt,
            randomPassword.iterations,
            now,
          )
          .run()
      }

      await db
        .prepare(
          'INSERT INTO discord_identities (discord_id, account_id, username, display_name, avatar_url, email_masked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)',
        )
        .bind(discordId, accountId, username, displayName, avatarUrl, emailMasked, now)
        .run()
    } else {
      await db
        .prepare(
          'UPDATE discord_identities SET username = ?1, display_name = ?2, avatar_url = ?3, email_masked = ?4, updated_at = ?5 WHERE discord_id = ?6',
        )
        .bind(username, displayName, avatarUrl, emailMasked, now, discordId)
        .run()
    }

    const session = await createClientSession(db, accountId, c.req.raw, salt, ipHash)
    await recordClientLogin(db, accountId, 'discord', c.req.raw, ipHash)
    c.header('set-cookie', sessionCookie(session.token, c.req.raw), { append: true })
    c.header('set-cookie', clearDiscordStateCookie(c.req.raw), { append: true })
    return c.redirect('/dashboard/', 302)
  } catch (error) {
    console.warn('discord oauth: account session failed', error instanceof Error ? error.message : 'unknown')
    return discordErrorRedirect(c, 'oauth_failed')
  }
})

app.post('/api/client/auth/register', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const ip = clientIp(c.req.raw)
  if (isRateLimited(`register:${ip}`)) return c.json({ error: 'rate_limited' }, 429)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const email = normalizeEmail(payload?.email)
  const password = payload?.password
  if (!email || !isStrongEnoughPassword(password)) return c.json({ error: 'invalid_credentials' }, 400)

  const salt = saltOf(c.env)
  const emailHash = await hashEmail(email, salt)
  const existing = await db.prepare('SELECT id FROM client_accounts WHERE email_hash = ?1').bind(emailHash).first()
  if (existing) return c.json({ error: 'account_exists' }, 409)
  const passwordData = await hashPassword(password)
  const id = crypto.randomUUID()
  const now = nowIso()
  await db
    .prepare(
      'INSERT INTO client_accounts (id, email_hash, email_masked, password_hash, password_salt, password_iterations, totp_enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)',
    )
    .bind(id, emailHash, maskEmail(email), passwordData.hash, passwordData.salt, passwordData.iterations, now)
    .run()
  const ipHash = await hashSecret(ip, salt)
  const session = await createClientSession(db, id, c.req.raw, salt, ipHash)
  await recordClientLogin(db, id, 'register', c.req.raw, ipHash)
  c.header('set-cookie', sessionCookie(session.token, c.req.raw))
  return c.json({ ok: true, account: { id, emailMasked: maskEmail(email), totpEnabled: false } }, 201)
})

app.post('/api/client/auth/login', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const ip = clientIp(c.req.raw)
  if (isRateLimited(`login:${ip}`)) return c.json({ error: 'rate_limited' }, 429)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const email = normalizeEmail(payload?.email)
  const password = payload?.password
  if (!email || typeof password !== 'string') return c.json({ error: 'invalid_credentials' }, 400)

  const salt = saltOf(c.env)
  const emailHash = await hashEmail(email, salt)
  const account = await db
    .prepare('SELECT * FROM client_accounts WHERE email_hash = ?1')
    .bind(emailHash)
    .first<Record<string, unknown>>()
  if (!account) return c.json({ error: 'invalid_credentials' }, 401)
  const valid = await verifyPassword(
    password,
    String(account.password_hash),
    String(account.password_salt),
    Number(account.password_iterations),
  )
  if (!valid) return c.json({ error: 'invalid_credentials' }, 401)
  if (Number(account.totp_enabled) === 1) {
    const code = typeof payload?.totp === 'string' ? payload.totp.trim() : ''
    if (!code) return c.json({ error: 'totp_required' }, 401)
    if (!(await verifyTotp(String(account.totp_secret || ''), code))) {
      return c.json({ error: 'invalid_totp' }, 401)
    }
  }

  const ipHash = await hashSecret(ip, salt)
  const session = await createClientSession(db, String(account.id), c.req.raw, salt, ipHash)
  await recordClientLogin(db, String(account.id), 'login', c.req.raw, ipHash)
  c.header('set-cookie', sessionCookie(session.token, c.req.raw))
  return c.json({
    ok: true,
    account: {
      id: account.id,
      emailMasked: account.email_masked,
      totpEnabled: Number(account.totp_enabled) === 1,
    },
  })
})

app.get('/api/client/auth/session', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ ok: true, account: session.account })
})

app.post('/api/client/auth/logout', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (session) {
    await db
      .prepare('UPDATE client_sessions SET revoked_at = ?1 WHERE id = ?2')
      .bind(nowIso(), session.sessionId)
      .run()
  }
  c.header('set-cookie', clearSessionCookie(c.req.raw))
  return c.json({ ok: true })
})

app.post('/api/client/auth/password', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const current = payload?.currentPassword
  const next = payload?.newPassword
  if (typeof current !== 'string' || !isStrongEnoughPassword(next)) return c.json({ error: 'invalid_password' }, 400)
  const account = await db
    .prepare('SELECT password_hash, password_salt, password_iterations FROM client_accounts WHERE id = ?1')
    .bind(session.account.id)
    .first<{ password_hash: string; password_salt: string; password_iterations: number }>()
  if (!account) return c.json({ error: 'not_found' }, 404)
  if (!(await verifyPassword(current, account.password_hash, account.password_salt, Number(account.password_iterations)))) {
    return c.json({ error: 'invalid_password' }, 401)
  }
  const nextData = await hashPassword(next)
  await db.batch([
    db
      .prepare('UPDATE client_accounts SET password_hash = ?1, password_salt = ?2, password_iterations = ?3, updated_at = ?4 WHERE id = ?5')
      .bind(nextData.hash, nextData.salt, nextData.iterations, nowIso(), session.account.id),
    db
      .prepare('UPDATE client_sessions SET revoked_at = ?1 WHERE account_id = ?2 AND id <> ?3')
      .bind(nowIso(), session.account.id, session.sessionId),
  ])
  await recordClientLogin(
    db,
    session.account.id,
    'password_changed',
    c.req.raw,
    await hashSecret(clientIp(c.req.raw), saltOf(c.env)),
  )
  return c.json({ ok: true })
})

app.post('/api/client/auth/2fa/setup', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const secret = newTotpSecret()
  await db
    .prepare('UPDATE client_accounts SET totp_secret = ?1, totp_enabled = 0, updated_at = ?2 WHERE id = ?3')
    .bind(secret, nowIso(), session.account.id)
    .run()
  return c.json({ ok: true, secret, otpauth: otpauthUrl(session.account.emailMasked, secret) })
})

app.post('/api/client/auth/2fa/enable', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const code = typeof payload?.code === 'string' ? payload.code.trim() : ''
  const account = await db
    .prepare('SELECT totp_secret FROM client_accounts WHERE id = ?1')
    .bind(session.account.id)
    .first<{ totp_secret: string | null }>()
  if (!account?.totp_secret || !(await verifyTotp(account.totp_secret, code))) {
    return c.json({ error: 'invalid_totp' }, 400)
  }
  await db.prepare('UPDATE client_accounts SET totp_enabled = 1, updated_at = ?1 WHERE id = ?2').bind(nowIso(), session.account.id).run()
  await recordClientLogin(db, session.account.id, '2fa_enabled', c.req.raw, await hashSecret(clientIp(c.req.raw), saltOf(c.env)))
  return c.json({ ok: true })
})

app.post('/api/client/auth/2fa/disable', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const code = typeof payload?.code === 'string' ? payload.code.trim() : ''
  const account = await db
    .prepare('SELECT totp_secret FROM client_accounts WHERE id = ?1')
    .bind(session.account.id)
    .first<{ totp_secret: string | null }>()
  if (!account?.totp_secret || !(await verifyTotp(account.totp_secret, code))) {
    return c.json({ error: 'invalid_totp' }, 400)
  }
  await db
    .prepare('UPDATE client_accounts SET totp_secret = NULL, totp_enabled = 0, updated_at = ?1 WHERE id = ?2')
    .bind(nowIso(), session.account.id)
    .run()
  await recordClientLogin(db, session.account.id, '2fa_disabled', c.req.raw, await hashSecret(clientIp(c.req.raw), saltOf(c.env)))
  return c.json({ ok: true })
})

app.get('/api/client/auth/sessions', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const { results } = await db
    .prepare(
      'SELECT id, created_at, last_seen_at, expires_at, ip_hash, user_agent FROM client_sessions WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 30',
    )
    .bind(session.account.id, nowIso())
    .all()
  return c.json({
    ok: true,
    sessions: (results ?? []).map((row) => ({
      ...(row as Record<string, unknown>),
      current: (row as Record<string, unknown>).id === session.sessionId,
    })),
  })
})

app.delete('/api/client/auth/sessions/:id', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const result = await db
    .prepare('UPDATE client_sessions SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL')
    .bind(nowIso(), c.req.param('id'), session.account.id)
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  if (c.req.param('id') === session.sessionId) c.header('set-cookie', clearSessionCookie(c.req.raw))
  return c.json({ ok: true })
})

app.get('/api/client/auth/events', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const { results } = await db
    .prepare('SELECT kind, ip_hash, user_agent, created_at FROM client_login_events WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 30')
    .bind(session.account.id)
    .all()
  return c.json({ ok: true, events: results ?? [] })
})

app.post('/api/client/auth/link', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  if (!isSameOriginRequest(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const rows = Array.isArray(payload?.orders) ? payload.orders.slice(0, 50) : []
  const ids: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    const orderId = typeof entry.orderId === 'string' ? entry.orderId.trim() : ''
    const token = typeof entry.token === 'string' ? entry.token.trim().toLowerCase() : ''
    if (!isValidOrderId(orderId) || !CLIENT_TOKEN_RE.test(token)) continue
    if (sameSecret(token, await clientOrderToken(c.env, orderId))) ids.push(orderId)
  }
  if (ids.length) {
    const now = nowIso()
    await db.batch(
      ids.map((orderId) =>
        db
          .prepare('INSERT OR IGNORE INTO client_order_links (account_id, order_id, created_at) VALUES (?1, ?2, ?3)')
          .bind(session.account.id, orderId, now),
      ),
    )
  }
  return c.json({ ok: true, linked: ids.length })
})

app.get('/api/client/auth/orders', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'account_unavailable' }, 503)
  const session = await getClientSession(db, c.req.raw, saltOf(c.env))
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  const { results } = await db
    .prepare(
      `SELECT m.order_id, m.discord, m.items_json, m.total_cents, m.currency, m.status AS legacy_status,
              COALESCE(w.status, m.status) AS workflow_status, m.paypal_ref, m.created_at, m.updated_at,
              p.code AS promo_code, p.discount_cents
       FROM manual_orders m
       JOIN client_order_links l ON l.order_id = m.order_id AND l.account_id = ?1
       LEFT JOIN order_workflow w ON w.order_id = m.order_id
       LEFT JOIN promo_redemptions p ON p.order_id = m.order_id
       ORDER BY m.created_at DESC LIMIT 100`,
    )
    .bind(session.account.id)
    .all()
  const orders = (results ?? []) as Array<Record<string, unknown>>
  if (!orders.length) return c.json({ ok: true, orders: [] })
  const ids = orders.map((order) => String(order.order_id))
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ')
  const [keyResult, ticketResult, eventResult] = await db.batch([
    db.prepare(`SELECT order_id, product_slug, id, secret, status, delivered_at FROM stock_keys WHERE order_id IN (${placeholders}) AND status = 'delivered' ORDER BY created_at ASC`).bind(...ids),
    db.prepare(`SELECT id, order_id, subject, status, priority, assignee, updated_at FROM support_tickets WHERE order_id IN (${placeholders}) ORDER BY updated_at DESC`).bind(...ids),
    db.prepare(`SELECT order_id, type, to_status, note, created_at FROM order_events WHERE order_id IN (${placeholders}) ORDER BY created_at ASC`).bind(...ids),
  ])
  const group = (rows: unknown[] | undefined) => {
    const map = new Map<string, Array<Record<string, unknown>>>()
    for (const row of rows ?? []) {
      if (!row || typeof row !== 'object') continue
      const value = row as Record<string, unknown>
      const key = String(value.order_id || '')
      if (!key) continue
      const list = map.get(key) || []
      list.push(value)
      map.set(key, list)
    }
    return map
  }
  const keys = group(keyResult.results)
  const tickets = group(ticketResult.results)
  const events = group(eventResult.results)
  return c.json({
    ok: true,
    orders: orders.map((order) => {
      const reference = typeof order.paypal_ref === 'string' ? order.paypal_ref : ''
      const copy = { ...order }
      delete copy.paypal_ref
      return {
        ...copy,
        paypal_ref_masked: reference ? `${reference.slice(0, 4)}••••${reference.slice(-4)}` : null,
        keys: keys.get(String(order.order_id)) ?? [],
        tickets: tickets.get(String(order.order_id)) ?? [],
        events: events.get(String(order.order_id)) ?? [],
      }
    }),
  })
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
CREATE TABLE IF NOT EXISTS manual_orders (
  order_id      TEXT PRIMARY KEY,
  discord       TEXT NOT NULL,
  paypal_ref    TEXT NOT NULL,
  items_json    TEXT NOT NULL,
  total_cents   INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'EUR',
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_orders_paypal_ref ON manual_orders (paypal_ref);
CREATE INDEX IF NOT EXISTS idx_manual_orders_status ON manual_orders (status, created_at DESC);
CREATE TABLE IF NOT EXISTS promo_codes (
  code             TEXT PRIMARY KEY,
  percent_off      INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  amount_off_cents INTEGER NOT NULL DEFAULT 0,
  min_total_cents  INTEGER NOT NULL DEFAULT 0,
  max_uses         INTEGER,
  uses             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  expires_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  order_id       TEXT PRIMARY KEY,
  code           TEXT NOT NULL,
  discount_cents INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO promo_codes (code, percent_off, max_uses, uses, active)
VALUES ('EGO10', 10, 1000, 0, 1);
CREATE TABLE IF NOT EXISTS order_workflow (
  order_id     TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','dispute','cancelled')),
  updated_at   TEXT NOT NULL,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_workflow_status ON order_workflow (status, updated_at DESC);
CREATE TABLE IF NOT EXISTS order_events (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, created_at DESC);
CREATE TABLE IF NOT EXISTS staff_members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','support','logistics')),
  token_hash    TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT,
  actor_name    TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details_json  TEXT,
  ip_hash       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS blacklist (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('ip','paypal','discord','email')),
  value_hash    TEXT NOT NULL,
  value_masked  TEXT NOT NULL,
  reason        TEXT,
  created_by    TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (kind, value_hash)
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  discord         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee        TEXT,
  source          TEXT NOT NULL DEFAULT 'site',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON support_tickets (order_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('client','staff','system')),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages (ticket_id, created_at ASC);
CREATE TABLE IF NOT EXISTS canned_responses (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_stock (
  slug                TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT,
  price_cents         INTEGER,
  stock               INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  active              INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_keys (
  id           TEXT PRIMARY KEY,
  product_slug TEXT NOT NULL,
  secret       TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','delivered','disabled')),
  order_id     TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (product_slug, secret_hash)
);
CREATE INDEX IF NOT EXISTS idx_stock_keys_product ON stock_keys (product_slug, status, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_keys_order ON stock_keys (order_id, status);
CREATE TABLE IF NOT EXISTS client_accounts (
  id                  TEXT PRIMARY KEY,
  email_hash          TEXT NOT NULL UNIQUE,
  email_masked        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  password_salt       TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  totp_secret         TEXT,
  totp_enabled        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discord_identities (
  discord_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL UNIQUE,
  username     TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  email_masked TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_identity_account ON discord_identities (account_id);
CREATE TABLE IF NOT EXISTS client_sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_sessions_account ON client_sessions (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS client_order_links (
  account_id TEXT NOT NULL,
  order_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_client_links_order ON client_order_links (order_id);
CREATE TABLE IF NOT EXISTS client_login_events (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ip_hash    TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_login_account ON client_login_events (account_id, created_at DESC);
INSERT OR IGNORE INTO order_workflow (order_id, status, updated_at, updated_by)
SELECT order_id, status, updated_at, 'init' FROM manual_orders;
INSERT OR IGNORE INTO canned_responses (id, title, body, created_at)
VALUES ('commande-recue', 'Commande reçue', 'Merci pour ton message. Je vérifie ta commande et je reviens vers toi rapidement.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       ('livraison-discord', 'Livraison Discord', 'Ta commande est prête. Ouvre un ticket dans #support-achat avec ton numéro de commande et ton ID de transaction PayPal.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`

const admin = new Hono<AppEnv>()

admin.use('*', async (c, next) => {
  const db = c.env.DB
  const ownerToken = c.env.ADMIN_TOKEN
  const header = c.req.header('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '').trim()
  if (!provided) return c.json({ error: 'unauthorized' }, 401)

  if (ownerToken && sameSecret(provided, ownerToken)) {
    c.set('staff', { id: 'owner', name: 'Owner', role: 'admin', via: 'owner' })
    await next()
    return
  }

  if (db) {
    const tokenHash = await hashSecret(`staff:${provided}`, saltOf(c.env))
    const row = await db
      .prepare('SELECT id, name, role FROM staff_members WHERE token_hash = ?1 AND active = 1')
      .bind(tokenHash)
      .first<{ id: string; name: string; role: StaffActor['role'] }>()
    if (row) {
      c.set('staff', { id: row.id, name: row.name, role: row.role, via: 'staff' })
      await db
        .prepare('UPDATE staff_members SET last_seen_at = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), row.id)
        .run()
        .catch(() => {})
      await next()
      return
    }
  }

  if (!ownerToken && !db) return c.json({ error: 'admin_not_configured' }, 503)
  return c.json({ error: 'unauthorized' }, 401)
})

// ------------------------------------------------------- console helpers

const nowIso = () => new Date().toISOString()
const actorOf = (c: Context<AppEnv>) => c.get('staff')
const adminOnly = (c: Context<AppEnv>) =>
  actorOf(c).role === 'admin' ? null : c.json({ error: 'forbidden' }, 403)

const legacyStatusFor = (status: string): 'pending' | 'delivered' | 'cancelled' => {
  if (status === 'delivered') return 'delivered'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

type OrderItem = { slug: string; name: string; quantity: number; amountCents: number }

const parseOrderItems = (raw: unknown): OrderItem[] => {
  let rows: unknown = raw
  if (typeof raw === 'string') {
    try {
      rows = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      const item = row as Record<string, unknown>
      return {
        slug: typeof item.slug === 'string' ? item.slug : '',
        name: typeof item.name === 'string' ? item.name : String(item.slug || 'Produit'),
        quantity: Math.max(1, Number(item.quantity) || 1),
        amountCents: Number(item.amountCents) || 0,
      }
    })
}

const categoryFor = (slug: string, name: string): string => {
  const value = `${slug} ${name}`.toLowerCase()
  if (/discord|nitro|boost|serveur|server/.test(value)) return 'Discord'
  if (/vpn|vanish|cyberghost|nord|mullvad|express|tunnelbear/.test(value)) return 'VPN'
  if (/netflix|spotify|prime|hbo|crunchyroll|youtube|apple-music|deezer|paramount|atres|movistar|amc|nfl|ufc|nba/.test(value)) return 'Streaming'
  if (/chatgpt|claude|gemini|deepseek|perplexity|canva|capcut|adobe|wondershare|oneplay/.test(value)) return 'IA & outils'
  if (/fortnite|robux|valorant|cs2|rust|gta|minecraft|fivem|steam|epic|ea-fc|2k|troph|skins|level/.test(value)) return 'Gaming'
  return 'Comptes & autres'
}

const audit = async (
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string | null,
  details?: Record<string, unknown>,
): Promise<void> => {
  const db = c.env.DB
  if (!db) return
  const actor = actorOf(c)
  const ipHash = await hashSecret(clientIp(c.req.raw), saltOf(c.env))
  await db
    .prepare(
      'INSERT INTO audit_logs (id, actor_id, actor_name, action, target_type, target_id, details_json, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    )
    .bind(
      crypto.randomUUID(),
      actor.id,
      actor.name,
      action,
      targetType,
      targetId,
      details ? JSON.stringify(details).slice(0, 4000) : null,
      ipHash,
      nowIso(),
    )
    .run()
    .catch(() => {})
}

const addOrderEvent = async (
  c: Context<AppEnv>,
  orderId: string,
  type: string,
  fromStatus: string | null,
  toStatus: string | null,
  note?: string | null,
): Promise<void> => {
  const db = c.env.DB
  if (!db) return
  await db
    .prepare(
      'INSERT INTO order_events (id, order_id, type, from_status, to_status, actor, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      crypto.randomUUID(),
      orderId,
      type,
      fromStatus,
      toStatus,
      actorOf(c).name,
      note ? note.slice(0, 1000) : null,
      nowIso(),
    )
    .run()
    .catch(() => {})
}

const setOrderWorkflow = async (
  c: Context<AppEnv>,
  orderId: string,
  status: string,
): Promise<boolean> => {
  const db = c.env.DB
  if (!db) return false
  const legacy = legacyStatusFor(status)
  const timestamp = nowIso()
  const actor = actorOf(c)
  await db.batch([
    db
      .prepare(
        'INSERT INTO order_workflow (order_id, status, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(order_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .bind(orderId, status, timestamp, actor.name),
    db
      .prepare('UPDATE manual_orders SET status = ?1, updated_at = ?2 WHERE order_id = ?3')
      .bind(legacy, timestamp, orderId),
  ])
  return true
}

const maskBlacklistValue = (kind: string, value: string): string => {
  if (kind === 'discord') return `@${value.slice(0, 3)}…${value.slice(-2)}`
  if (kind === 'paypal') return `${value.slice(0, 4)}…${value.slice(-4)}`
  if (kind === 'email') {
    const at = value.indexOf('@')
    return at > 0 ? `${value.slice(0, 1)}…${value.slice(at)}` : '•••'
  }
  return 'empreinte IP'
}

const normalizeBlacklistValue = (kind: string, raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  if (kind === 'discord') return normalizeDiscord(value)
  if (kind === 'paypal') {
    const ref = value.toUpperCase()
    return PAYPAL_REF_RE.test(ref) ? ref : null
  }
  if (kind === 'email') return value.toLowerCase()
  if (kind === 'ip') return value
  return null
}

const blacklistBlocked = async (
  db: D1Database,
  env: Env,
  input: { ip: string; discord: string; paypalRef: string },
): Promise<boolean> => {
  const salt = saltOf(env)
  const [ipHash, paypalHash, discordHash] = await Promise.all([
    hashSecret(`blacklist:ip:${input.ip}`, salt),
    hashSecret(`blacklist:paypal:${input.paypalRef}`, salt),
    hashSecret(`blacklist:discord:${input.discord}`, salt),
  ])
  const row = await db
    .prepare(
      "SELECT kind FROM blacklist WHERE active = 1 AND ((kind = 'ip' AND value_hash = ?1) OR (kind = 'paypal' AND value_hash = ?2) OR (kind = 'discord' AND value_hash = ?3)) LIMIT 1",
    )
    .bind(ipHash, paypalHash, discordHash)
    .first()
  return Boolean(row)
}

const stockRows = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM stock_keys k WHERE k.product_slug = p.slug AND k.status = 'available') AS available_keys,
        (SELECT COUNT(*) FROM stock_keys k WHERE k.product_slug = p.slug AND k.status = 'delivered') AS delivered_keys
       FROM product_stock p ORDER BY p.name COLLATE NOCASE LIMIT 300`,
    )
    .all()
  return results ?? []
}

const ticketRows = async (db: D1Database, limit = 200) => {
  const { results } = await db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
        (SELECT body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM support_tickets t ORDER BY t.last_message_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all()
  return results ?? []
}

const upsertWorkflowForNewOrder = (
  db: D1Database,
  orderId: string,
  createdAt: string,
): D1PreparedStatement =>
  db
    .prepare(
      "INSERT OR IGNORE INTO order_workflow (order_id, status, updated_at, updated_by) VALUES (?1, 'pending', ?2, 'client')",
    )
    .bind(orderId, createdAt)

const eventForNewOrder = (db: D1Database, orderId: string, createdAt: string): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO order_events (id, order_id, type, from_status, to_status, actor, note, created_at) VALUES (?1, ?2, 'created', NULL, 'pending', 'client', NULL, ?3)",
    )
    .bind(crypto.randomUUID(), orderId, createdAt)

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

admin.get('/me', (c) => c.json({ ok: true, staff: actorOf(c) }))

admin.get('/overview', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)

  const { results } = await db
    .prepare(
      `SELECT m.order_id, m.items_json, m.total_cents, m.created_at,
              COALESCE(w.status, m.status) AS workflow_status
       FROM manual_orders m LEFT JOIN order_workflow w ON w.order_id = m.order_id
       ORDER BY m.created_at DESC LIMIT 1000`,
    )
    .all()
  const orders = (results ?? []) as Array<{
    order_id: string
    items_json: string
    total_cents: number
    created_at: string
    workflow_status: string
  }>

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const revenueFor = (since: string) =>
    orders
      .filter((order) => order.created_at >= since && ['paid', 'delivered'].includes(order.workflow_status))
      .reduce((sum, order) => sum + (Number(order.total_cents) || 0), 0)

  const counts: Record<string, number> = { pending: 0, paid: 0, delivered: 0, dispute: 0, cancelled: 0 }
  for (const order of orders) {
    counts[order.workflow_status] = (counts[order.workflow_status] || 0) + 1
  }
  const total = orders.length
  const validated = counts.paid + counts.delivered
  const conversion = total ? Math.round((validated / total) * 1000) / 10 : 0

  const categories = new Map<string, { count: number; revenueCents: number }>()
  for (const order of orders) {
    if (order.created_at < monthAgo) continue
    if (!['paid', 'delivered'].includes(order.workflow_status)) continue
    for (const item of parseOrderItems(order.items_json)) {
      const key = categoryFor(item.slug, item.name)
      const entry = categories.get(key) || { count: 0, revenueCents: 0 }
      entry.count += item.quantity
      entry.revenueCents += item.amountCents * item.quantity
      categories.set(key, entry)
    }
  }

  const openTickets = await db
    .prepare("SELECT COUNT(*) AS count FROM support_tickets WHERE status IN ('open','pending')")
    .first<{ count: number }>()
  const stock = (await stockRows(db)) as Array<Record<string, unknown>>
  const lowStock = stock.filter((row) => {
    const keys = Number(row.available_keys) || 0
    const declared = Number(row.stock) || 0
    const effective = keys > 0 ? keys : declared
    return Number(row.active) === 1 && effective <= (Number(row.low_stock_threshold) || 3)
  })
  const recentAudit = await db
    .prepare('SELECT actor_name, action, target_type, target_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 8')
    .all()

  return c.json({
    ok: true,
    kpis: {
      revenueDay: revenueFor(dayAgo),
      revenueWeek: revenueFor(weekAgo),
      revenueMonth: revenueFor(monthAgo),
      totalOrders: total,
      counts,
      conversion,
      openTickets: Number(openTickets?.count || 0),
      lowStock: lowStock.length,
    },
    categories: [...categories.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.revenueCents - a.revenueCents),
    lowStock: lowStock.slice(0, 8),
    recentOrders: orders.slice(0, 6).map((order) => ({
      order_id: order.order_id,
      total_cents: order.total_cents,
      created_at: order.created_at,
      workflow_status: order.workflow_status,
    })),
    recentAudit: recentAudit.results ?? [],
  })
})

admin.get('/manual-orders', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)
  const { results } = await db
    .prepare(
      `SELECT m.order_id, m.discord, m.paypal_ref, m.items_json, m.total_cents, m.currency, m.note,
              m.status AS legacy_status, COALESCE(w.status, m.status) AS workflow_status,
              m.created_at, m.updated_at, p.code AS promo_code, p.discount_cents,
              (SELECT COUNT(*) FROM stock_keys k WHERE k.order_id = m.order_id AND k.status = 'delivered') AS keys_count
       FROM manual_orders m
       LEFT JOIN order_workflow w ON w.order_id = m.order_id
       LEFT JOIN promo_redemptions p ON p.order_id = m.order_id
       ORDER BY m.created_at DESC LIMIT 200`,
    )
    .all()
  return c.json({ ok: true, orders: results ?? [] })
})

admin.get('/manual-orders/:id', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)
  const orderId = c.req.param('id')
  const order = await db
    .prepare(
      `SELECT m.*, COALESCE(w.status, m.status) AS workflow_status,
              p.code AS promo_code, p.discount_cents
       FROM manual_orders m LEFT JOIN order_workflow w ON w.order_id = m.order_id
       LEFT JOIN promo_redemptions p ON p.order_id = m.order_id
       WHERE m.order_id = ?1`,
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  if (!order) return c.json({ error: 'not_found' }, 404)
  const [events, keys, tickets] = await db.batch([
    db.prepare('SELECT * FROM order_events WHERE order_id = ?1 ORDER BY created_at DESC LIMIT 50').bind(orderId),
    db.prepare('SELECT id, secret, status, created_at, delivered_at FROM stock_keys WHERE order_id = ?1 ORDER BY created_at ASC').bind(orderId),
    db.prepare('SELECT id, subject, status, priority, assignee, updated_at FROM support_tickets WHERE order_id = ?1 ORDER BY last_message_at DESC').bind(orderId),
  ])
  return c.json({
    ok: true,
    order: { ...order, items: parseOrderItems(order.items_json) },
    events: events.results ?? [],
    keys: keys.results ?? [],
    tickets: tickets.results ?? [],
  })
})

admin.post('/manual-orders/:id/status', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const status = typeof payload?.status === 'string' ? payload.status : ''
  if (!['pending', 'paid', 'delivered', 'dispute', 'cancelled'].includes(status)) {
    return c.json({ error: 'invalid_status' }, 400)
  }
  const orderId = c.req.param('id')
  const existing = await db
    .prepare(
      'SELECT COALESCE(w.status, m.status) AS status FROM manual_orders m LEFT JOIN order_workflow w ON w.order_id = m.order_id WHERE m.order_id = ?1',
    )
    .bind(orderId)
    .first<{ status: string }>()
  if (!existing) return c.json({ error: 'not_found' }, 404)
  await setOrderWorkflow(c, orderId, status)
  await addOrderEvent(c, orderId, 'status', existing.status, status, typeof payload?.note === 'string' ? payload.note : null)
  await audit(c, 'order.status', 'manual_order', orderId, { from: existing.status, to: status })
  return c.json({ ok: true, id: orderId, status, legacyStatus: legacyStatusFor(status) })
})

admin.post('/manual-orders/:id/deliver', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)
  const orderId = c.req.param('id')
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const mode = payload?.mode === 'keys' ? 'keys' : 'manual'
  const order = await db
    .prepare('SELECT items_json, status FROM manual_orders WHERE order_id = ?1')
    .bind(orderId)
    .first<{ items_json: string; status: string }>()
  if (!order) return c.json({ error: 'not_found' }, 404)

  let keysAllocated = 0
  if (mode === 'keys') {
    const allocations: Array<{ id: string; slug: string }> = []
    const missing: Array<{ slug: string; needed: number; available: number }> = []
    for (const item of parseOrderItems(order.items_json)) {
      const { results } = await db
        .prepare("SELECT id FROM stock_keys WHERE product_slug = ?1 AND status = 'available' ORDER BY created_at ASC LIMIT ?2")
        .bind(item.slug, item.quantity)
        .all<{ id: string }>()
      const found = results ?? []
      if (found.length < item.quantity) {
        missing.push({ slug: item.slug, needed: item.quantity, available: found.length })
      } else {
        allocations.push(...found.map((row) => ({ id: row.id, slug: item.slug })))
      }
    }
    if (missing.length) return c.json({ error: 'insufficient_keys', missing }, 409)
    if (allocations.length) {
      const deliveredAt = nowIso()
      await db.batch(
        allocations.map((row) =>
          db
            .prepare("UPDATE stock_keys SET status = 'delivered', order_id = ?1, delivered_at = ?2 WHERE id = ?3 AND status = 'available'")
            .bind(orderId, deliveredAt, row.id),
        ),
      )
      keysAllocated = allocations.length
    }
  }

  await setOrderWorkflow(c, orderId, 'delivered')
  await addOrderEvent(c, orderId, 'delivery', order.status, 'delivered', mode === 'keys' ? `${keysAllocated} cle(s) livree(s)` : 'Livraison manuelle Discord')
  await audit(c, 'order.deliver', 'manual_order', orderId, { mode, keysAllocated })
  return c.json({ ok: true, id: orderId, status: 'delivered', mode, keysAllocated })
})

admin.delete('/manual-orders/:id', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'manual_orders_unavailable' }, 503)
  const orderId = c.req.param('id')
  const result = await db.prepare('DELETE FROM manual_orders WHERE order_id = ?1').bind(orderId).run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'order.delete', 'manual_order', orderId)
  return c.json({ ok: true, id: orderId })
})

admin.get('/stock', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'stock_unavailable' }, 503)
  return c.json({ ok: true, products: await stockRows(db) })
})

admin.post('/stock', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'stock_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const slug = typeof payload.slug === 'string' ? payload.slug.trim() : ''
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : ''
  if (!isValidSlug(slug) || name.length < 2) return c.json({ error: 'invalid_product' }, 400)

  const category = typeof payload.category === 'string' && payload.category.trim()
    ? payload.category.trim().slice(0, 40)
    : categoryFor(slug, name)
  const price = Number(payload.priceCents)
  const priceCents = Number.isInteger(price) && price >= 0 ? price : null
  const stock = Number(payload.stock ?? 0)
  const threshold = Number(payload.lowStockThreshold ?? 3)
  if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) return c.json({ error: 'invalid_stock' }, 400)
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000) return c.json({ error: 'invalid_threshold' }, 400)

  await db
    .prepare(
      `INSERT INTO product_stock (slug, name, category, price_cents, stock, low_stock_threshold, active, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name, category = excluded.category, price_cents = excluded.price_cents,
         stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
         active = excluded.active, updated_at = excluded.updated_at`,
    )
    .bind(slug, name, category, priceCents, stock, threshold, payload.active === false ? 0 : 1, nowIso())
    .run()
  await audit(c, 'stock.save', 'product_stock', slug, { name, stock, priceCents, threshold })
  return c.json({ ok: true, slug })
})

admin.get('/stock/:slug/keys', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'stock_unavailable' }, 503)
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) return c.json({ error: 'invalid_product' }, 400)
  const status = c.req.query('status')
  const allowed = ['available', 'reserved', 'delivered', 'disabled']
  const statement = allowed.includes(status ?? '')
    ? db.prepare('SELECT id, secret, status, order_id, note, created_at, delivered_at FROM stock_keys WHERE product_slug = ?1 AND status = ?2 ORDER BY created_at ASC LIMIT 500').bind(slug, status)
    : db.prepare('SELECT id, secret, status, order_id, note, created_at, delivered_at FROM stock_keys WHERE product_slug = ?1 ORDER BY created_at ASC LIMIT 500').bind(slug)
  const { results } = await statement.all()
  return c.json({ ok: true, keys: results ?? [] })
})

admin.post('/stock/:slug/keys', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'stock_unavailable' }, 503)
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) return c.json({ error: 'invalid_product' }, 400)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const rawLines = Array.isArray(payload.keys)
    ? payload.keys.map((entry) => String(entry))
    : typeof payload.text === 'string'
      ? payload.text.split(/\r?\n/)
      : []
  const keys = [...new Set(rawLines.map((line) => line.trim()).filter(Boolean))]
    .filter((line) => line.length >= 3 && line.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line))
    .slice(0, 1000)
  if (!keys.length) return c.json({ error: 'invalid_keys' }, 400)

  const existing = await db.prepare('SELECT slug FROM product_stock WHERE slug = ?1').bind(slug).first()
  if (!existing) {
    const product = PRICES[slug]
    await db
      .prepare(
        'INSERT INTO product_stock (slug, name, category, price_cents, stock, low_stock_threshold, active, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 3, 1, ?5)',
      )
      .bind(slug, product?.name ?? slug, categoryFor(slug, product?.name ?? slug), product?.amountCents ?? null, nowIso())
      .run()
  }

  const salt = saltOf(c.env)
  const statements = []
  for (const key of keys) {
    const keyHash = await hashSecret(`stock-key:${slug}:${key}`, salt)
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO stock_keys (id, product_slug, secret, secret_hash, status, created_at) VALUES (?1, ?2, ?3, ?4, 'available', ?5)",
        )
        .bind(crypto.randomUUID(), slug, key, keyHash, nowIso()),
    )
  }
  const results = await db.batch(statements)
  const inserted = results.reduce((sum, result) => sum + (Number(result.meta.changes) || 0), 0)
  await audit(c, 'stock.keys_import', 'product_stock', slug, { total: keys.length, inserted })
  return c.json({ ok: true, slug, total: keys.length, inserted, skipped: keys.length - inserted })
})

admin.post('/stock/:slug/keys/:id/disable', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'stock_unavailable' }, 503)
  const result = await db
    .prepare("UPDATE stock_keys SET status = 'disabled' WHERE id = ?1 AND product_slug = ?2 AND status = 'available'")
    .bind(c.req.param('id'), c.req.param('slug'))
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'stock.key_disable', 'stock_key', c.req.param('id'), { slug: c.req.param('slug') })
  return c.json({ ok: true })
})

admin.get('/tickets', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const status = c.req.query('status')
  const allowed = ['open', 'pending', 'resolved', 'closed']
  if (allowed.includes(status ?? '')) {
    const { results } = await db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
                (SELECT body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
         FROM support_tickets t WHERE t.status = ?1 ORDER BY t.last_message_at DESC LIMIT 200`,
      )
      .bind(status)
      .all()
    return c.json({ ok: true, tickets: results ?? [] })
  }
  return c.json({ ok: true, tickets: await ticketRows(db) })
})

admin.get('/tickets/:id', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const ticket = await db.prepare('SELECT * FROM support_tickets WHERE id = ?1').bind(c.req.param('id')).first()
  if (!ticket) return c.json({ error: 'not_found' }, 404)
  const { results } = await db
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = ?1 ORDER BY created_at ASC LIMIT 300')
    .bind(c.req.param('id'))
    .all()
  return c.json({ ok: true, ticket, messages: results ?? [] })
})

admin.post('/tickets/:id/messages', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const message = cleanText(payload?.message, 2, 4000)
  if (!message) return c.json({ error: 'invalid_message' }, 400)
  const ticketId = c.req.param('id')
  const ticket = await db.prepare('SELECT id FROM support_tickets WHERE id = ?1').bind(ticketId).first()
  if (!ticket) return c.json({ error: 'not_found' }, 404)
  const timestamp = nowIso()
  const id = crypto.randomUUID()
  await db.batch([
    db
      .prepare("INSERT INTO ticket_messages (id, ticket_id, author_type, author_name, body, created_at) VALUES (?1, ?2, 'staff', ?3, ?4, ?5)")
      .bind(id, ticketId, actorOf(c).name, message, timestamp),
    db
      .prepare("UPDATE support_tickets SET status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE 'pending' END, updated_at = ?1, last_message_at = ?1 WHERE id = ?2")
      .bind(timestamp, ticketId),
  ])
  await audit(c, 'ticket.reply', 'ticket', ticketId, { length: message.length })
  return c.json({ ok: true, message: { id, body: message, created_at: timestamp } }, 201)
})

admin.post('/tickets/:id/status', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const status = typeof payload?.status === 'string' ? payload.status : ''
  if (!['open', 'pending', 'resolved', 'closed'].includes(status)) return c.json({ error: 'invalid_status' }, 400)
  const result = await db
    .prepare('UPDATE support_tickets SET status = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(status, nowIso(), c.req.param('id'))
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'ticket.status', 'ticket', c.req.param('id'), { status })
  return c.json({ ok: true, status })
})

admin.post('/tickets/:id/assign', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const assignee = typeof payload?.assignee === 'string' ? payload.assignee.trim().slice(0, 40) || null : null
  const result = await db
    .prepare('UPDATE support_tickets SET assignee = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(assignee, nowIso(), c.req.param('id'))
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'ticket.assign', 'ticket', c.req.param('id'), { assignee })
  return c.json({ ok: true, assignee })
})

admin.get('/canned-responses', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const { results } = await db.prepare('SELECT * FROM canned_responses ORDER BY title COLLATE NOCASE').all()
  return c.json({ ok: true, responses: results ?? [] })
})

admin.post('/canned-responses', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 80) : ''
  const body = cleanText(payload?.body, 2, 4000)
  if (title.length < 2 || !body) return c.json({ error: 'invalid_response' }, 400)
  const id = typeof payload?.id === 'string' && payload.id ? payload.id.slice(0, 60) : crypto.randomUUID()
  await db
    .prepare(
      'INSERT INTO canned_responses (id, title, body, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body',
    )
    .bind(id, title, body, nowIso())
    .run()
  await audit(c, 'canned.save', 'canned_response', id, { title })
  return c.json({ ok: true, id }, 201)
})

admin.delete('/canned-responses/:id', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'tickets_unavailable' }, 503)
  const result = await db.prepare('DELETE FROM canned_responses WHERE id = ?1').bind(c.req.param('id')).run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'canned.delete', 'canned_response', c.req.param('id'))
  return c.json({ ok: true })
})

admin.get('/audit', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'audit_unavailable' }, 503)
  const { results } = await db
    .prepare('SELECT id, actor_name, action, target_type, target_id, details_json, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 250')
    .all()
  return c.json({ ok: true, logs: results ?? [] })
})

admin.get('/blacklist', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'blacklist_unavailable' }, 503)
  const { results } = await db
    .prepare('SELECT id, kind, value_masked, reason, created_by, active, created_at FROM blacklist ORDER BY created_at DESC LIMIT 250')
    .all()
  return c.json({ ok: true, entries: results ?? [] })
})

admin.post('/blacklist', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'blacklist_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const kind = typeof payload?.kind === 'string' ? payload.kind : ''
  if (!['ip', 'paypal', 'discord', 'email'].includes(kind)) return c.json({ error: 'invalid_kind' }, 400)
  const value = normalizeBlacklistValue(kind, payload?.value)
  if (!value) return c.json({ error: 'invalid_value' }, 400)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim().slice(0, 200) : null
  const valueHash = await hashSecret(`blacklist:${kind}:${value}`, saltOf(c.env))
  await db
    .prepare(
      `INSERT INTO blacklist (id, kind, value_hash, value_masked, reason, created_by, active, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
       ON CONFLICT(kind, value_hash) DO UPDATE SET active = 1, reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`,
    )
    .bind(crypto.randomUUID(), kind, valueHash, maskBlacklistValue(kind, value), reason, actorOf(c).name, nowIso())
    .run()
  await audit(c, 'blacklist.add', 'blacklist', null, { kind, masked: maskBlacklistValue(kind, value) })
  return c.json({ ok: true }, 201)
})

admin.post('/blacklist/:id/toggle', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'blacklist_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (typeof payload?.active !== 'boolean') return c.json({ error: 'invalid_active' }, 400)
  const result = await db
    .prepare('UPDATE blacklist SET active = ?1 WHERE id = ?2')
    .bind(payload.active ? 1 : 0, c.req.param('id'))
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'blacklist.toggle', 'blacklist', c.req.param('id'), { active: payload.active })
  return c.json({ ok: true, active: payload.active })
})

admin.get('/staff', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'staff_unavailable' }, 503)
  const { results } = await db
    .prepare('SELECT id, name, role, active, created_at, last_seen_at FROM staff_members ORDER BY created_at ASC')
    .all()
  return c.json({ ok: true, staff: results ?? [] })
})

admin.post('/staff', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'staff_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 40) : ''
  const role = typeof payload?.role === 'string' ? payload.role : ''
  if (name.length < 2) return c.json({ error: 'invalid_name' }, 400)
  if (!['admin', 'support', 'logistics'].includes(role)) return c.json({ error: 'invalid_role' }, 400)
  const token = randomHex(24)
  const tokenHash = await hashSecret(`staff:${token}`, saltOf(c.env))
  const id = crypto.randomUUID()
  await db
    .prepare('INSERT INTO staff_members (id, name, role, token_hash, active, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)')
    .bind(id, name, role, tokenHash, nowIso())
    .run()
  await audit(c, 'staff.create', 'staff', id, { name, role })
  return c.json({ ok: true, staff: { id, name, role }, token }, 201)
})

admin.post('/staff/:id/toggle', async (c) => {
  const denied = adminOnly(c)
  if (denied) return denied
  const db = c.env.DB
  if (!db) return c.json({ error: 'staff_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (typeof payload?.active !== 'boolean') return c.json({ error: 'invalid_active' }, 400)
  if (c.req.param('id') === actorOf(c).id) return c.json({ error: 'cannot_disable_self' }, 400)
  const result = await db
    .prepare('UPDATE staff_members SET active = ?1 WHERE id = ?2')
    .bind(payload.active ? 1 : 0, c.req.param('id'))
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  await audit(c, 'staff.toggle', 'staff', c.req.param('id'), { active: payload.active })
  return c.json({ ok: true, active: payload.active })
})

admin.get('/promo-codes', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'promo_unavailable' }, 503)
  const { results } = await db
    .prepare(
      'SELECT code, percent_off, amount_off_cents, min_total_cents, max_uses, uses, active, expires_at, created_at FROM promo_codes ORDER BY created_at DESC LIMIT 100',
    )
    .all()
  return c.json({ ok: true, codes: results ?? [] })
})

admin.post('/promo-codes', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'promo_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!payload) return c.json({ error: 'invalid_body' }, 400)

  const code = normalizePromoCode(payload.code)
  const percentOff = Number(payload.percentOff ?? 0)
  const amountOffCents = Number(payload.amountOffCents ?? 0)
  const minTotalCents = Number(payload.minTotalCents ?? 0)
  const maxUsesRaw = payload.maxUses
  const maxUses =
    maxUsesRaw === undefined || maxUsesRaw === null || maxUsesRaw === '' ? null : Number(maxUsesRaw)
  const expiresRaw = typeof payload.expiresAt === 'string' ? payload.expiresAt.trim() : ''
  const expiresMs = expiresRaw ? Date.parse(expiresRaw) : null
  const expiresAt = expiresMs !== null && !Number.isNaN(expiresMs) ? new Date(expiresMs).toISOString() : null
  const active = payload.active === false ? 0 : 1

  if (!code) return c.json({ error: 'invalid_code' }, 400)
  if (!Number.isInteger(percentOff) || percentOff < 0 || percentOff > 90) {
    return c.json({ error: 'invalid_percent' }, 400)
  }
  if (!Number.isInteger(amountOffCents) || amountOffCents < 0) {
    return c.json({ error: 'invalid_amount' }, 400)
  }
  if (!Number.isInteger(minTotalCents) || minTotalCents < 0) {
    return c.json({ error: 'invalid_minimum' }, 400)
  }
  if (percentOff === 0 && amountOffCents === 0) return c.json({ error: 'invalid_discount' }, 400)
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
    return c.json({ error: 'invalid_max_uses' }, 400)
  }
  if (expiresRaw && expiresAt === null) {
    return c.json({ error: 'invalid_expiry' }, 400)
  }

  await db
    .prepare(
      `INSERT INTO promo_codes (code, percent_off, amount_off_cents, min_total_cents, max_uses, active, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(code) DO UPDATE SET
         percent_off = excluded.percent_off,
         amount_off_cents = excluded.amount_off_cents,
         min_total_cents = excluded.min_total_cents,
         max_uses = excluded.max_uses,
         active = excluded.active,
         expires_at = excluded.expires_at`,
    )
    .bind(code, percentOff, amountOffCents, minTotalCents, maxUses, active, expiresAt)
    .run()

  return c.json({ ok: true, code }, 201)
})

admin.post('/promo-codes/:code/toggle', async (c) => {
  const db = c.env.DB
  if (!db) return c.json({ error: 'promo_unavailable' }, 503)
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null)
  const active = payload?.active
  if (typeof active !== 'boolean') return c.json({ error: 'invalid_active' }, 400)
  const result = await db
    .prepare('UPDATE promo_codes SET active = ?1 WHERE code = ?2')
    .bind(active ? 1 : 0, c.req.param('code').toUpperCase())
    .run()
  if (!result.meta.changes) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, code: c.req.param('code').toUpperCase(), active })
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

const setReviewStatus = async (c: Context<AppEnv>, status: 'hidden' | 'published') => {
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
