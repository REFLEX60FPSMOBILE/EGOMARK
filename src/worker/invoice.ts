// Reçu PDF minimal, généré sans dépendance. Les accents sont translittérés
// pour rester compatible avec la police Helvetica standard du PDF.

export type InvoiceItem = { name: string; quantity: number; amountCents: number }
export type InvoiceInput = {
  orderId: string
  createdAt: string
  discord: string
  currency: string
  items: InvoiceItem[]
  subtotalCents: number
  discountCents: number
  totalCents: number
  paypalMasked: string | null
  status: string
  promoCode: string | null
}

const ascii = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/€/g, 'EUR')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/•/g, '-')
    .replace(/[^\x20-\x7e]/g, '?')

const money = (cents: number, currency: string): string =>
  `${(Math.max(0, Math.round(cents)) / 100).toFixed(2)} ${currency.toUpperCase()}`

const escapePdf = (value: string): string =>
  ascii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const statusLabel = (status: string): string => {
  if (status === 'delivered') return 'Livree'
  if (status === 'paid') return 'Payee'
  if (status === 'dispute') return 'Litige'
  if (status === 'cancelled') return 'Annulee'
  return 'En verification'
}

export function buildInvoicePdf(input: InvoiceInput): Uint8Array {
  const lines: Array<{ text: string; size?: number }> = [
    { text: 'EGO MARKET', size: 22 },
    { text: 'Recu de commande', size: 13 },
    { text: '' },
    { text: `Commande : ${input.orderId}` },
    { text: `Date : ${new Date(input.createdAt).toLocaleString('fr-FR')}` },
    { text: `Client Discord : @${input.discord}` },
    { text: `Statut : ${statusLabel(input.status)}` },
  ]
  if (input.paypalMasked) lines.push({ text: `Transaction PayPal : ${input.paypalMasked}` })
  lines.push({ text: '' }, { text: 'Articles', size: 13 })
  const items = input.items.slice(0, 18)
  for (const item of items) {
    lines.push({
      text: `${item.name} x${item.quantity}   ${money(item.amountCents * item.quantity, input.currency)}`,
    })
  }
  if (input.items.length > items.length) {
    lines.push({ text: `... et ${input.items.length - items.length} autre(s) article(s)` })
  }
  lines.push({ text: '' })
  lines.push({ text: `Sous-total : ${money(input.subtotalCents, input.currency)}` })
  if (input.discountCents > 0) {
    lines.push({
      text: `Remise${input.promoCode ? ` ${input.promoCode}` : ''} : -${money(input.discountCents, input.currency)}`,
    })
  }
  lines.push({ text: `Total : ${money(input.totalCents, input.currency)}`, size: 13 })
  lines.push({ text: '' })
  lines.push({ text: 'Paiement PayPal - recu genere depuis votre espace client.' })
  lines.push({ text: 'La livraison et le support se font sur le serveur Discord EGO.' })

  const contentLines = ['BT', '14 TL', '50 800 Td']
  for (const line of lines) {
    contentLines.push(`/F1 ${line.size || 10} Tf`)
    contentLines.push(`(${escapePdf(line.text)}) Tj`)
    contentLines.push('T*')
  }
  contentLines.push('ET')
  const content = contentLines.join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
