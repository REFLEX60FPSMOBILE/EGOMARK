// Espace client : vault, progression, support et compte sécurisé.
// Le suivi local par jeton reste disponible sans compte.
(() => {
  'use strict'

  const ORDERS_KEY = 'ego-orders-v1'
  const DISCORD_KEY = 'ego-discord-v1'
  const MAX_ORDERS = 50
  const REFRESH_MS = 60_000
  const state = {
    entries: [],
    account: null,
    orders: [],
    tickets: [],
    selectedTicketId: '',
    selectedTicket: null,
    sessions: [],
    events: [],
    authMode: 'login',
    totpRequired: false,
    loading: false,
    lastUpdated: null,
  }

  const $ = (id) => document.getElementById(id)
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  const node = (tag, className, text) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = String(text)
    return element
  }
  const money = (cents, currency = 'EUR') => {
    const amount = Number(cents)
    if (!Number.isFinite(amount)) return '—'
    try {
      return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'EUR' }).format(amount / 100)
    } catch {
      return `${(amount / 100).toFixed(2)} €`
    }
  }
  const fullDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  const clock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const dateValue = (value) => {
    const timestamp = Date.parse(value || '')
    return Number.isFinite(timestamp) ? new Date(timestamp) : null
  }
  const fmtDate = (value) => {
    const date = dateValue(value)
    return date ? fullDate.format(date) : '—'
  }
  const statusLabel = (status) =>
    ({
      pending: 'À vérifier',
      paid: 'Payée',
      delivered: 'Livrée',
      dispute: 'Litige',
      cancelled: 'Annulée',
      open: 'Ouvert',
      resolved: 'Résolu',
      closed: 'Fermé',
    })[status] || status || '—'
  const parseItems = (order) => {
    let raw = []
    try {
      raw = JSON.parse(order?.items_json || '[]')
    } catch {
      return []
    }
    return Array.isArray(raw)
      ? raw.map((item) => ({
          name: String(item?.name || item?.slug || 'Produit'),
          slug: String(item?.slug || ''),
          quantity: Math.max(1, Number(item?.quantity) || 1),
          amountCents: Number(item?.amountCents) || 0,
        }))
      : []
  }

  let noticeTimer = null
  let toastTimer = null

  const setNotice = (message, tone = '') => {
    const notice = $('notice')
    if (noticeTimer) window.clearTimeout(noticeTimer)
    noticeTimer = null
    notice.textContent = message || ''
    notice.dataset.tone = tone
    notice.hidden = !message
    if (message && tone !== 'error') {
      noticeTimer = window.setTimeout(() => {
        notice.hidden = true
      }, 7000)
    }
  }
  const showToast = (message, tone = 'success') => {
    const toast = $('toast')
    if (toastTimer) window.clearTimeout(toastTimer)
    toast.textContent = message
    toast.dataset.tone = tone
    toast.hidden = false
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 4200)
  }
  const setError = (id, message) => {
    const element = $(id)
    if (!element) return
    element.textContent = message || ''
    element.hidden = !message
  }
  const errorLabel = (error) => {
    const map = {
      invalid_credentials: 'E-mail ou mot de passe incorrect.',
      account_exists: 'Un compte existe déjà avec cet e-mail.',
      invalid_password: 'Mot de passe actuel incorrect ou nouveau mot de passe trop court.',
      totp_required: 'Entre ton code de double authentification.',
      invalid_totp: 'Code 2FA invalide ou expiré.',
      rate_limited: 'Trop de tentatives. Réessaie dans un instant.',
      unauthorized: 'Cette action nécessite une connexion ou un jeton de commande valide.',
      paypal_already_set: 'Une transaction PayPal est déjà associée à cette commande.',
      invalid_paypal_ref: 'ID de transaction PayPal invalide.',
      paypal_ref_exists: 'Cette transaction est déjà utilisée par une autre commande.',
      blocked: 'Cette commande ou ce client est bloqué. Contacte le support.',
      order_not_found: 'Aucune commande ne correspond à ce numéro et à cette transaction.',
      invalid_ticket: 'Sujet ou message invalide.',
      invalid_message: 'Message invalide.',
      insufficient_keys: 'Le stock de clés est insuffisant.',
    }
    return map[error?.code] || 'L’opération n’a pas pu être terminée.'
  }
  const discordErrorLabel = (code) =>
    ({
      access_denied: 'Connexion Discord annulée.',
      not_configured: 'La connexion Discord n’est pas encore configurée.',
      state_mismatch: 'La session de connexion a expiré. Réessaie.',
      token_exchange_failed: 'Discord n’a pas pu valider la connexion.',
      user_fetch_failed: 'Impossible de récupérer ton profil Discord.',
      discord_already_linked: 'Ce compte est déjà lié à un autre Discord.',
      discord_unavailable: 'Discord est momentanément indisponible.',
      oauth_failed: 'La connexion Discord a échoué. Réessaie.',
    })[code] || 'La connexion Discord a échoué. Réessaie.'

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      cache: 'no-store',
      credentials: 'same-origin',
    })
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      /* réponse vide */
    }
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`)
      error.code = payload.error || ''
      error.status = response.status
      error.payload = payload
      throw error
    }
    return payload
  }

  // ----------------------------------------------------------------- stockage
  const readEntries = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]')
      if (!Array.isArray(raw)) return []
      return raw
        .filter((entry) => entry && typeof entry.orderId === 'string' && typeof entry.token === 'string')
        .map((entry) => ({ orderId: entry.orderId.trim(), token: entry.token.trim() }))
        .filter((entry) => entry.orderId && entry.token)
        .slice(0, MAX_ORDERS)
    } catch {
      return []
    }
  }
  const saveEntries = () => {
    try {
      localStorage.setItem(ORDERS_KEY, JSON.stringify(state.entries))
    } catch {
      setNotice('Le stockage local est indisponible : le suivi ne sera pas conservé.', 'error')
    }
  }
  const readDiscord = () => {
    try {
      return (localStorage.getItem(DISCORD_KEY) || '').trim()
    } catch {
      return ''
    }
  }
  const entryFor = (orderId) => state.entries.find((entry) => entry.orderId === orderId)
  const orderFor = (orderId) => state.orders.find((order) => order.order_id === orderId)

  // ------------------------------------------------------------------ données
  const loadSession = async () => {
    try {
      const data = await request('/api/client/auth/session')
      return data.account || null
    } catch (error) {
      if (error.status === 401) return null
      throw error
    }
  }
  const loadLocalOrders = async () => {
    if (!state.entries.length) return []
    const data = await request('/api/client/orders', {
      method: 'POST',
      body: JSON.stringify({ orders: state.entries }),
    })
    return (data.orders || []).map((order) => ({ ...order, token: entryFor(order.order_id)?.token || '' }))
  }
  const loadAccountOrders = async () => {
    if (!state.account) return []
    const data = await request('/api/client/auth/orders')
    return data.orders || []
  }
  const loadTickets = async () => {
    const data = await request('/api/client/tickets/list', {
      method: 'POST',
      body: JSON.stringify({ orders: state.entries }),
    })
    return data.tickets || []
  }
  const linkLocalOrders = async () => {
    if (!state.account || !state.entries.length) return
    await request('/api/client/auth/link', {
      method: 'POST',
      body: JSON.stringify({ orders: state.entries }),
    }).catch(() => {})
  }

  async function refresh({ silent = false } = {}) {
    if (state.loading) return
    state.loading = true
    $('refresh').disabled = true
    if (!silent) setNotice('')
    try {
      state.account = await loadSession()
      if (state.account) await linkLocalOrders()
      const [localOrders, accountOrders, tickets] = await Promise.all([
        loadLocalOrders(),
        loadAccountOrders(),
        loadTickets(),
      ])
      const merged = new Map(accountOrders.map((order) => [order.order_id, order]))
      for (const order of localOrders) {
        const existing = merged.get(order.order_id) || {}
        merged.set(order.order_id, { ...existing, ...order, token: order.token || existing.token || '' })
      }
      state.orders = [...merged.values()].sort(
        (a, b) => (dateValue(b.created_at)?.getTime() || 0) - (dateValue(a.created_at)?.getTime() || 0),
      )
      state.tickets = tickets
      if (state.selectedTicketId) {
        state.selectedTicket = tickets.find((ticket) => ticket.id === state.selectedTicketId) || null
        if (!state.selectedTicket) state.selectedTicketId = ''
      }
      state.lastUpdated = new Date()
      renderAll()
      if (state.account) await loadAccountDetails()
    } catch (error) {
      if (error.code !== 'unauthorized') setNotice(errorLabel(error), 'error')
    } finally {
      state.loading = false
      $('refresh').disabled = false
    }
  }

  const loadAccountDetails = async () => {
    if (!state.account) return
    const [sessions, events] = await Promise.all([
      request('/api/client/auth/sessions').catch(() => ({ sessions: [] })),
      request('/api/client/auth/events').catch(() => ({ events: [] })),
    ])
    state.sessions = sessions.sessions || []
    state.events = events.events || []
    renderAccountDetails()
  }

  // -------------------------------------------------------------------- rendu
  const renderAll = () => {
    renderAuth()
    renderStats()
    renderVault()
    renderOrders()
    renderSupport()
    renderAccount()
    if (state.lastUpdated) {
      $('last-updated').textContent = `Actualisé à ${clock.format(state.lastUpdated)}`
      $('last-updated').title = fullDate.format(state.lastUpdated)
    }
  }

  const renderAuth = () => {
    $('client-auth-panel').hidden = Boolean(state.account)
    $('client-logout').hidden = !state.account
    $('account-logout').hidden = !state.account
    if (state.account) return
    const registering = state.authMode === 'register'
    $('client-auth-title').textContent = registering ? 'Créer un compte' : 'Se connecter'
    $('client-auth-note').textContent = registering
      ? 'Un compte permet de retrouver tes achats et tes clés sur tous tes appareils. Le suivi par commande reste disponible sans compte.'
      : 'Un compte permet de retrouver tes achats et tes clés sur tous tes appareils. Le suivi par commande reste disponible sans compte.'
    $('client-auth-submit').textContent = registering ? 'Créer mon compte' : 'Se connecter'
    $('client-auth-toggle').textContent = registering ? 'J’ai déjà un compte' : 'Créer un compte'
    $('client-password').autocomplete = registering ? 'new-password' : 'current-password'
    $('client-totp-field').hidden = registering || !state.totpRequired
  }

  const renderStats = () => {
    const pending = state.orders.filter((order) => order.workflow_status === 'pending').length
    const delivered = state.orders.filter((order) => order.workflow_status === 'delivered').length
    const amount = state.orders
      .filter((order) => order.workflow_status !== 'cancelled')
      .reduce((sum, order) => sum + (Number(order.total_cents) || 0), 0)
    $('stat-total').textContent = String(state.orders.length)
    $('stat-pending').textContent = String(pending)
    $('stat-delivered').textContent = String(delivered)
    $('stat-amount').textContent = money(amount)
    $('orders-count').textContent = `${state.orders.length} commande(s)`
    const discord = readDiscord()
    $('client-lead').textContent = discord
      ? `Commandes suivies sur cet espace, livraison sur @${discord}.`
      : 'Suis tes commandes, récupère tes clés et contacte le support.'
    $('forget').hidden = state.entries.length === 0
  }

  const invoiceButton = (order) => {
    const button = node('button', 'console-btn console-btn--sm', 'Facture PDF')
    button.type = 'button'
    button.dataset.invoice = order.order_id
    return button
  }

  const renderVault = () => {
    const list = $('vault-list')
    list.replaceChildren()
    let count = 0
    state.orders.forEach((order) => {
      const items = parseItems(order)
      for (const key of order.keys || []) {
        count += 1
        const item = items.find((entry) => entry.slug === key.product_slug) || items[0]
        const name = item?.name || key.product_slug || 'Produit'
        const card = node('article', 'console-vault__card')
        const secret = String(key.secret || '')
        const masked = '•'.repeat(Math.min(24, Math.max(10, secret.length)))
        card.innerHTML = `<h3>${esc(name)}</h3><p>Commande ${esc(order.order_id)} · ${fmtDate(key.delivered_at)}</p>
          <div class="console-secret"><span data-secret-value="${esc(secret)}" data-masked="${esc(masked)}">${esc(masked)}</span>
            <button class="console-btn console-btn--sm" type="button" data-reveal-key>Révéler</button>
            <button class="console-btn console-btn--sm" type="button" data-copy-key="${esc(secret)}">Copier</button>
          </div>`
        const actions = node('div', 'console-actions')
        actions.style.marginTop = '10px'
        actions.append(invoiceButton(order))
        card.append(actions)
        list.append(card)
      }
    })
    $('vault-empty').hidden = count !== 0
  }

  const progressFor = (order) => {
    const status = order.workflow_status
    const states = ['', '', '']
    if (status === 'delivered') states.fill('is-done')
    else if (status === 'paid') states[0] = 'is-done', states[1] = 'is-done', states[2] = 'is-current'
    else if (status === 'pending') states[0] = 'is-done', states[1] = 'is-current'
    return `<div class="console-progress"><div class="console-progress__steps">
      <div class="console-progress__step ${states[0]}">Paiement reçu</div>
      <div class="console-progress__step ${states[1]}">Validation</div>
      <div class="console-progress__step ${states[2]}">Livré</div>
    </div></div>`
  }

  const renderOrders = () => {
    const container = $('client-orders')
    container.replaceChildren()
    state.orders.forEach((order) => {
      const card = node('article', 'console-card')
      card.style.marginBottom = '12px'
      const items = parseItems(order)
      const discount = Number(order.discount_cents) || 0
      const total = Number(order.total_cents) || 0
      const status = order.workflow_status
      const canPaypal = !order.paypal_ref_masked && !['cancelled', 'delivered'].includes(status)
      card.innerHTML = `
        <header class="console-card__head">
          <div><h2>${esc(order.order_id)}</h2><p>${fmtDate(order.created_at)} · livraison @${esc(order.discord || '—')}</p></div>
          <span class="console-tag" data-status="${esc(status)}">${esc(statusLabel(status))}</span>
        </header>
        ${progressFor(order)}
        <ul class="console-list">
          ${items.map((item) => `<li class="console-list__row"><span>${esc(item.name)} ×${item.quantity}</span><strong>${money(item.amountCents * item.quantity, order.currency)}</strong></li>`).join('')}
        </ul>
        ${discount > 0 ? `<p class="console-note">Sous-total ${money(total + discount, order.currency)} · remise ${order.promo_code ? esc(order.promo_code) + ' ' : ''}−${money(discount, order.currency)}</p>` : ''}
        <div class="console-actions" style="margin-top:12px">
          ${order.paypal_ref_masked ? `<span class="console-tag" data-status="paid">PayPal ${esc(order.paypal_ref_masked)}</span>` : '<span class="console-tag" data-status="dispute">PayPal non renseigné</span>'}
          <button class="console-btn console-btn--sm" type="button" data-invoice="${esc(order.order_id)}">Facture PDF</button>
          <button class="console-btn console-btn--sm" type="button" data-ticket-order="${esc(order.order_id)}">Support</button>
        </div>`
      if (canPaypal) {
        const form = node('form', 'console-form')
        form.style.marginTop = '12px'
        form.innerHTML = `<div class="console-form__row"><label class="field"><span>ID transaction PayPal</span><input data-paypal-input="${esc(order.order_id)}" type="text" maxlength="64" required placeholder="Ex. 7AB12345CD678901E" /></label><button class="console-btn console-btn--primary" type="button" data-paypal-order="${esc(order.order_id)}">Enregistrer l’ID</button></div>`
        card.append(form)
      }
      container.append(card)
    })
    $('client-empty').hidden = state.orders.length !== 0
  }

  const renderSupport = () => {
    const select = $('client-ticket-order')
    const current = select.value
    select.innerHTML = state.orders
      .map((order) => `<option value="${esc(order.order_id)}">${esc(order.order_id)} · ${esc(statusLabel(order.workflow_status))}</option>`)
      .join('')
    if (current && state.orders.some((order) => order.order_id === current)) select.value = current

    const list = $('client-ticket-list')
    list.replaceChildren()
    state.tickets.forEach((ticket) => {
      const button = node('button', `console-ticket${ticket.id === state.selectedTicketId ? ' is-active' : ''}`)
      button.type = 'button'
      button.dataset.clientTicket = ticket.id
      button.innerHTML = `<strong>${esc(ticket.subject)}</strong><small>${esc(ticket.order_id)} · ${fmtDate(ticket.last_message_at || ticket.updated_at)}</small><div class="console-ticket__meta"><span class="console-tag" data-status="${esc(ticket.status)}">${esc(statusLabel(ticket.status))}</span></div>`
      list.append(button)
    })
    $('client-ticket-empty').hidden = state.tickets.length !== 0
    renderClientThread()
  }

  const renderClientThread = () => {
    const thread = $('client-ticket-thread')
    const empty = $('client-ticket-thread-empty')
    if (!state.selectedTicket) {
      thread.hidden = true
      empty.hidden = false
      return
    }
    thread.hidden = false
    empty.hidden = true
    $('client-ticket-subject').textContent = state.selectedTicket.subject
    $('client-ticket-meta').textContent = `Commande ${state.selectedTicket.order_id} · ${fmtDate(state.selectedTicket.updated_at)}`
    const status = $('client-ticket-status')
    status.textContent = statusLabel(state.selectedTicket.status)
    status.dataset.status = state.selectedTicket.status
    const messages = $('client-ticket-messages')
    messages.replaceChildren()
    ;(state.selectedTicket.messages || []).forEach((message) => {
      const row = node('div', `console-message${message.author_type === 'staff' ? ' console-message--staff' : ''}`)
      row.innerHTML = `<small>${esc(message.author_name || message.author_type)}</small><p>${esc(message.body)}</p><time>${fmtDate(message.created_at)}</time>`
      messages.append(row)
    })
    messages.scrollTop = messages.scrollHeight
  }

  const renderAccount = () => {
    $('account-signed-in').hidden = !state.account
    $('account-signed-out').hidden = Boolean(state.account)
    if (!state.account) return
    const account = state.account
    const displayName = account.displayName || account.emailMasked || 'Compte client'
    $('account-display').textContent = displayName
    const username = account.discordUsername ? `@${account.discordUsername}` : ''
    const email = account.emailMasked && account.emailMasked !== username ? account.emailMasked : ''
    $('account-email').textContent = [username, email].filter(Boolean).join(' · ') || 'Compte client'
    const avatar = $('account-avatar')
    if (avatar) {
      if (account.avatarUrl) {
        avatar.src = account.avatarUrl
        avatar.alt = `Avatar de ${displayName}`
        avatar.hidden = false
      } else {
        avatar.hidden = true
        avatar.removeAttribute('src')
        avatar.alt = ''
      }
    }
    const passwordCard = $('password-card')
    if (passwordCard) passwordCard.hidden = account.provider === 'discord'
    const enabled = Boolean(account.totpEnabled)
    $('account-2fa-status').textContent = enabled ? '2FA activée' : '2FA désactivée'
    $('account-2fa-status').dataset.status = enabled ? 'delivered' : 'pending'
    $('twofa-disable-block').hidden = !enabled
    $('twofa-setup-block').hidden = enabled
    if (enabled) $('twofa-secret-box').hidden = true
    renderAccountDetails()
  }

  const renderAccountDetails = () => {
    const sessions = $('sessions-list')
    sessions.replaceChildren()
    state.sessions.forEach((session) => {
      const row = node('div', 'console-session')
      row.innerHTML = `<div><strong>${session.current ? 'Cet appareil' : 'Session'}</strong><small>${fmtDate(session.created_at)} · vu ${fmtDate(session.last_seen_at)}</small><small>${esc(session.user_agent || 'appareil inconnu')}</small></div>${session.current ? '<span class="console-tag" data-status="delivered">active</span>' : `<button class="console-btn console-btn--sm console-btn--danger" type="button" data-revoke-session="${esc(session.id)}">Révoquer</button>`}`
      sessions.append(row)
    })
    if (!state.sessions.length) sessions.innerHTML = '<p class="console-muted">Aucune session active.</p>'

    const events = $('events-list')
    events.replaceChildren()
    state.events.forEach((event) => {
      const row = node('div', 'console-list__row')
      row.innerHTML = `<div><strong>${esc(event.kind)}</strong><small>${esc(event.user_agent || 'appareil inconnu')}</small></div><span class="console-muted">${fmtDate(event.created_at)}</span>`
      events.append(row)
    })
    if (!state.events.length) events.innerHTML = '<p class="console-muted">Aucun historique.</p>'
  }

  const setClientTab = (tab) => {
    document.querySelectorAll('[data-client-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.clientTab === tab)
    })
    document.querySelectorAll('[data-client-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.clientPanel !== tab
    })
  }

  const setAuthMode = (mode) => {
    state.authMode = mode
    state.totpRequired = false
    setError('client-auth-error', '')
    renderAuth()
  }

  // ------------------------------------------------------------------ actions
  const copyText = async (value, label = 'Code copié.') => {
    try {
      await navigator.clipboard.writeText(value)
      showToast(label)
    } catch {
      showToast('La copie automatique est indisponible.', 'error')
    }
  }

  async function downloadInvoice(orderId) {
    const order = orderFor(orderId)
    const headers = {}
    if (order?.token) headers.authorization = `Bearer ${order.token}`
    try {
      const response = await fetch(`/api/client/orders/${encodeURIComponent(orderId)}/invoice`, {
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('invoice failed')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `facture-${orderId}.pdf`
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch {
      showToast('La facture n’a pas pu être téléchargée.', 'error')
    }
  }

  async function savePaypal(orderId) {
    const order = orderFor(orderId)
    const input = document.querySelector(`[data-paypal-input="${CSS.escape(orderId)}"]`)
    const paypalRef = input?.value.trim().toUpperCase() || ''
    if (!paypalRef) {
      showToast('Entre l’ID de transaction PayPal.', 'error')
      return
    }
    try {
      await request(`/api/client/orders/${encodeURIComponent(orderId)}/paypal`, {
        method: 'POST',
        body: JSON.stringify({ orderId, token: order?.token || '', paypalRef }),
      })
      showToast('Transaction PayPal enregistrée.')
      await refresh({ silent: true })
    } catch (error) {
      showToast(errorLabel(error), 'error')
    }
  }

  async function openTicketFor(orderId) {
    setClientTab('support')
    const select = $('client-ticket-order')
    select.value = orderId
    $('client-ticket-subject').focus()
  }

  async function selectClientTicket(ticketId) {
    state.selectedTicketId = ticketId
    state.selectedTicket = state.tickets.find((ticket) => ticket.id === ticketId) || null
    renderSupport()
  }

  async function revokeSession(sessionId) {
    try {
      await request(`/api/client/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      showToast('Session révoquée.')
      await loadAccountDetails()
    } catch (error) {
      showToast(errorLabel(error), 'error')
    }
  }

  // -------------------------------------------------------------------- auth
  $('client-auth-toggle').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'))
  $('client-auth-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('client-auth-error', '')
    const email = $('client-email').value.trim()
    const password = $('client-password').value
    const totp = $('client-totp').value.trim()
    if (!email || !password) {
      setError('client-auth-error', 'Renseigne ton e-mail et ton mot de passe.')
      return
    }
    $('client-auth-submit').disabled = true
    try {
      const payload =
        state.authMode === 'register'
          ? { email, password }
          : { email, password, ...(totp ? { totp } : {}) }
      const data = await request(`/api/client/auth/${state.authMode}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      state.account = {
        ...data.account,
        displayName: data.account.displayName || data.account.emailMasked || 'Compte client',
        avatarUrl: data.account.avatarUrl || null,
        discordId: data.account.discordId || null,
        discordUsername: data.account.discordUsername || null,
        provider: data.account.provider || 'password',
      }
      state.totpRequired = false
      $('client-password').value = ''
      $('client-totp').value = ''
      showToast(state.authMode === 'register' ? 'Compte créé.' : 'Connexion réussie.')
      await refresh()
      renderAll()
    } catch (error) {
      if (error.code === 'totp_required') {
        state.totpRequired = true
        $('client-totp-field').hidden = false
        setError('client-auth-error', 'Entre ton code 2FA pour terminer la connexion.')
        $('client-totp').focus()
      } else if (error.code === 'account_exists') {
        setAuthMode('login')
        setError('client-auth-error', 'Ce compte existe déjà. Connecte-toi.')
      } else {
        setError('client-auth-error', errorLabel(error))
      }
    } finally {
      $('client-auth-submit').disabled = false
    }
  })

  const logout = async () => {
    try {
      await request('/api/client/auth/logout', { method: 'POST' })
    } catch {
      /* la session locale est nettoyée quand même */
    }
    state.account = null
    state.sessions = []
    state.events = []
    state.selectedTicket = null
    state.selectedTicketId = ''
    setClientTab('vault')
    await refresh({ silent: true })
    renderAll()
    showToast('Déconnecté.')
  }
  $('client-logout').addEventListener('click', logout)
  $('account-logout').addEventListener('click', logout)

  // ------------------------------------------------------------------ events
  $('refresh').addEventListener('click', () => refresh())
  $('client-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-client-tab]')
    if (button) setClientTab(button.dataset.clientTab)
  })
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go-client-tab]')
    if (go) setClientTab(go.dataset.goClientTab)
  })
  $('vault-list').addEventListener('click', (event) => {
    const invoice = event.target.closest('[data-invoice]')
    if (invoice) {
      downloadInvoice(invoice.dataset.invoice)
      return
    }
    const reveal = event.target.closest('[data-reveal-key]')
    if (reveal) {
      const secret = reveal.parentElement.querySelector('[data-secret-value]')
      if (!secret) return
      const revealed = secret.dataset.revealed === '1'
      secret.textContent = revealed ? secret.dataset.masked : secret.dataset.secretValue
      secret.dataset.revealed = revealed ? '0' : '1'
      reveal.textContent = revealed ? 'Révéler' : 'Masquer'
      return
    }
    const copy = event.target.closest('[data-copy-key]')
    if (copy) copyText(copy.dataset.copyKey, 'Clé copiée.')
  })
  $('client-orders').addEventListener('click', (event) => {
    const invoice = event.target.closest('[data-invoice]')
    if (invoice) {
      downloadInvoice(invoice.dataset.invoice)
      return
    }
    const paypal = event.target.closest('[data-paypal-order]')
    if (paypal) savePaypal(paypal.dataset.paypalOrder)
    const ticket = event.target.closest('[data-ticket-order]')
    if (ticket) openTicketFor(ticket.dataset.ticketOrder)
  })
  $('client-ticket-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-client-ticket]')
    if (button) selectClientTicket(button.dataset.clientTicket)
  })
  $('client-ticket-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('client-ticket-error', '')
    const orderId = $('client-ticket-order').value
    const order = orderFor(orderId)
    const subject = $('client-ticket-subject').value.trim()
    const message = $('client-ticket-message').value.trim()
    if (!orderId || !subject || !message) {
      setError('client-ticket-error', 'Choisis une commande et renseigne le sujet et le message.')
      return
    }
    $('client-ticket-submit').disabled = true
    try {
      await request('/api/client/tickets', {
        method: 'POST',
        body: JSON.stringify({ orderId, token: order?.token || '', subject, message }),
      })
      $('client-ticket-subject').value = ''
      $('client-ticket-message').value = ''
      showToast('Ticket envoyé au support.')
      await refresh({ silent: true })
      setClientTab('support')
    } catch (error) {
      setError('client-ticket-error', errorLabel(error))
    } finally {
      $('client-ticket-submit').disabled = false
    }
  })
  $('client-ticket-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const ticket = state.selectedTicket
    if (!ticket) return
    const message = $('client-ticket-reply').value.trim()
    if (!message) return
    const order = orderFor(ticket.order_id)
    $('client-ticket-send').disabled = true
    try {
      await request(`/api/client/tickets/${encodeURIComponent(ticket.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ orderId: ticket.order_id, token: order?.token || '', message }),
      })
      $('client-ticket-reply').value = ''
      await refresh({ silent: true })
      showToast('Message envoyé.')
    } catch (error) {
      showToast(errorLabel(error), 'error')
    } finally {
      $('client-ticket-send').disabled = false
    }
  })

  $('claim-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('claim-error', '')
    const orderId = $('claim-order').value.trim().toUpperCase()
    const paypalRef = $('claim-ref').value.trim().toUpperCase()
    if (!orderId || !paypalRef) {
      setError('claim-error', 'Renseigne le numéro de commande et l’ID PayPal.')
      return
    }
    $('claim-submit').disabled = true
    try {
      const data = await request('/api/client/claim', {
        method: 'POST',
        body: JSON.stringify({ orderId, paypalRef }),
      })
      if (!state.entries.some((entry) => entry.orderId === data.orderId)) {
        state.entries = [{ orderId: data.orderId, token: data.token }, ...state.entries].slice(0, MAX_ORDERS)
        saveEntries()
      }
      $('claim-form').reset()
      await refresh({ silent: true })
      showToast('Commande ajoutée au suivi.')
    } catch (error) {
      setError('claim-error', errorLabel(error))
    } finally {
      $('claim-submit').disabled = false
    }
  })

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('password-error', '')
    const currentPassword = $('current-password').value
    const newPassword = $('new-password').value
    $('password-submit').disabled = true
    try {
      await request('/api/client/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      $('password-form').reset()
      showToast('Mot de passe mis à jour. Les autres sessions ont été révoquées.')
      await loadAccountDetails()
    } catch (error) {
      setError('password-error', errorLabel(error))
    } finally {
      $('password-submit').disabled = false
    }
  })

  $('twofa-setup').addEventListener('click', async () => {
    setError('twofa-error', '')
    try {
      const data = await request('/api/client/auth/2fa/setup', { method: 'POST' })
      $('twofa-secret-box').hidden = false
      $('twofa-secret').textContent = data.secret
      $('twofa-uri').textContent = data.otpauth
      $('twofa-code').focus()
    } catch (error) {
      showToast(errorLabel(error), 'error')
    }
  })
  $('twofa-enable-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('twofa-error', '')
    try {
      await request('/api/client/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: $('twofa-code').value.trim() }),
      })
      state.account.totpEnabled = true
      $('twofa-code').value = ''
      $('twofa-secret-box').hidden = true
      showToast('2FA activée.')
      renderAccount()
    } catch (error) {
      setError('twofa-error', errorLabel(error))
    }
  })
  $('twofa-disable-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setError('twofa-disable-error', '')
    try {
      await request('/api/client/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ code: $('twofa-disable-code').value.trim() }),
      })
      state.account.totpEnabled = false
      $('twofa-disable-code').value = ''
      showToast('2FA désactivée.')
      renderAccount()
    } catch (error) {
      setError('twofa-disable-error', errorLabel(error))
    }
  })
  $('sessions-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-revoke-session]')
    if (button) revokeSession(button.dataset.revokeSession)
  })

  $('forget').addEventListener('click', () => {
    if (!window.confirm('Oublier les commandes suivies sur cet appareil ?')) return
    state.entries = []
    try {
      localStorage.removeItem(ORDERS_KEY)
    } catch {
      /* rien à faire */
    }
    refresh()
    showToast('Suivi local oublié.')
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true })
  })
  window.setInterval(() => {
    if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true })
  }, REFRESH_MS)

  // -------------------------------------------------------------------- init
  const params = new URLSearchParams(window.location.search)
  const oauthError = params.get('discord_error')
  if (oauthError) {
    setNotice(discordErrorLabel(oauthError), 'error')
    params.delete('discord_error')
    const query = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }
  state.entries = readEntries()
  renderAuth()
  renderStats()
  refresh()
})()
