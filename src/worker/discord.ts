// Notification Discord des nouvelles commandes manuelles.
// Best-effort : un webhook absent ou en échec ne doit jamais empêcher
// l'enregistrement de la commande ni modifier la réponse au client.

import type { CartItem } from './cart'

export type DiscordOrderInput = {
  orderId: string
  discord: string
  paypalRef: string
  items: CartItem[]
  subtotalCents: number
  discountCents: number
  totalCents: number
  promoCode: string | null
  note: string | null
  createdAt: string
}

const euro = (cents: number) =>
  `${(Math.max(0, Math.round(cents)) / 100).toFixed(2).replace('.', ',')} €`

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`

export function buildOrderNotification(order: DiscordOrderInput, adminUrl: string) {
  const items = order.items.map(
    (item) =>
      `• ${truncate(item.name, 90)} ×${item.quantity} — ${euro(item.amountCents * item.quantity)}`,
  )

  const totals = [`Sous-total : ${euro(order.subtotalCents)}`]
  if (order.discountCents > 0) {
    const label = order.promoCode ? `Remise ${order.promoCode}` : 'Remise'
    totals.push(`${label} : −${euro(order.discountCents)}`)
  }
  totals.push(`**Total : ${euro(order.totalCents)}**`)

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Client Discord', value: truncate(order.discord, 256), inline: true },
    { name: 'Référence PayPal', value: `\`${truncate(order.paypalRef, 64)}\``, inline: true },
    { name: 'Statut', value: 'Paiement à vérifier', inline: true },
    { name: 'Articles', value: truncate(items.join('\n'), 1024) },
    { name: 'Total', value: truncate(totals.join('\n'), 1024) },
  ]
  if (order.note) fields.push({ name: 'Note du client', value: truncate(order.note, 500) })

  return {
    username: 'EGO Market',
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: truncate(`Nouvelle commande — ${euro(order.totalCents)}`, 256),
        color: 0xf59e0b,
        fields,
        footer: { text: truncate(`Commande ${order.orderId}`, 2048) },
        timestamp: order.createdAt,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Ouvrir l'admin", url: adminUrl }],
      },
    ],
  }
}

// N'accepte que les webhooks Discord en HTTPS, plus le loopback HTTP pour les
// tests locaux. Une valeur mal configurée est ignorée silencieusement.
function webhookUrl(raw: string | undefined): URL | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (loopback) return url.protocol === 'http:' ? url : null

  const discordHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com'
  if (url.protocol !== 'https:' || !discordHost) return null
  if (!url.pathname.startsWith('/api/webhooks/')) return null
  return url
}

export async function notifyDiscordOrder(
  env: { DISCORD_WEBHOOK_URL?: string },
  order: DiscordOrderInput,
  adminUrl: string,
): Promise<boolean> {
  const url = webhookUrl(env.DISCORD_WEBHOOK_URL)
  if (!url) return false

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOrderNotification(order, adminUrl)),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      console.warn(`discord webhook: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.warn('discord webhook failed', error instanceof Error ? error.message : 'unknown error')
    return false
  }
}

export type DiscordTicketInput = {
  ticketId: string
  orderId: string
  discord: string
  subject: string
  message: string
  createdAt: string
  fromStaff?: boolean
}

export function buildTicketNotification(ticket: DiscordTicketInput, adminUrl: string) {
  return {
    username: 'EGO Market · Support',
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: truncate(`${ticket.fromStaff ? 'Réponse staff' : 'Nouveau ticket'} — ${ticket.subject}`, 256),
        color: ticket.fromStaff ? 0x22c55e : 0x3b82f6,
        fields: [
          { name: 'Client Discord', value: truncate(ticket.discord, 256), inline: true },
          { name: 'Commande', value: truncate(ticket.orderId, 256), inline: true },
          { name: 'Message', value: truncate(ticket.message, 1024) },
        ],
        footer: { text: truncate(`Ticket ${ticket.ticketId}`, 2048) },
        timestamp: ticket.createdAt,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'Ouvrir le support', url: adminUrl }],
      },
    ],
  }
}

export async function notifyDiscordTicket(
  env: { DISCORD_WEBHOOK_URL?: string },
  ticket: DiscordTicketInput,
  adminUrl: string,
): Promise<boolean> {
  const url = webhookUrl(env.DISCORD_WEBHOOK_URL)
  if (!url) return false
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildTicketNotification(ticket, adminUrl)),
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}
