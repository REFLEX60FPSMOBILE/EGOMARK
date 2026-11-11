// Console staff : analytics, commandes, stock, support, sécurité et promos.
// Le jeton reste en sessionStorage et chaque action est revalidée côté Worker.
(() => {
  'use strict'

  const TOKEN_KEY = 'ego-admin-token-v1'
  const REFRESH_MS = 60_000
  const state = {
    token: '',
    me: null,
    tab: 'overview',
    overview: null,
    orders: [],
    stock: [],
    tickets: [],
    selectedTicket: null,
    selectedTicketId: '',
    canned: [],
    promos: [],
    audit: [],
    blacklist: [],
    staff: [],
    query: '',
    filter: 'all',
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
  const shortDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' })
  const clock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const dateValue = (value) => {
    const timestamp = Date.parse(value || '')
    return Number.isFinite(timestamp) ? new Date(timestamp) : null
  }
  const fmtDate = (value) => {
    const date = dateValue(value)
    return date ? fullDate.format(date) : '—'
  }
  const fmtShort = (value) => {
    const date = dateValue(value)
    return date ? shortDate.format(date) : '—'
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

  const authGate = $('auth-gate')
  const app = $('console-app')
  const authForm = $('auth-form')
  const tokenInput = $('admin-token')
  const authSubmit = $('auth-submit')
  const authError = $('auth-error')
  const logoutButton = $('logout')
  const refreshButton = $('refresh')
  const notice = $('notice')
  const toast = $('toast')
  const drawer = $('order-drawer')

  let noticeTimer = null
  let toastTimer = null

  const setText = (id, value) => {
    const element = $(id)
    if (element) element.textContent = value === undefined || value === null ? '' : String(value)
  }
  const setNotice = (message, tone = '') => {
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
    if (toastTimer) window.clearTimeout(toastTimer)
    toast.textContent = message
    toast.dataset.tone = tone
    toast.hidden = false
    toastTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 4200)
  }
  const errorLabel = (error) => {
    const map = {
      unauthorized: 'Jeton refusé ou expiré.',
      forbidden: 'Ton rôle ne permet pas cette action.',
      admin_not_configured: 'ADMIN_TOKEN n’est pas configuré côté serveur.',
      order_exists: 'Cette commande existe déjà.',
      not_found: 'Ressource introuvable.',
      insufficient_keys: 'Clés insuffisantes pour livrer cette commande.',
      invalid_product: 'Produit invalide.',
      invalid_keys: 'Aucune clé valide détectée.',
      invalid_status: 'Statut invalide.',
      invalid_ticket: 'Ticket invalide.',
      rate_limited: 'Trop de requêtes. Réessaie dans un instant.',
      cannot_disable_self: 'Tu ne peux pas désactiver ton propre accès.',
    }
    if (map[error?.code]) return map[error.code]
    if (error?.status === 503) return 'Base D1 indisponible ou non initialisée.'
    if (error?.status === 401) return 'Jeton refusé ou expiré.'
    return 'L’action n’a pas pu être terminée.'
  }

  const readToken = () => {
    try {
      return (sessionStorage.getItem(TOKEN_KEY) || '').trim()
    } catch {
      return ''
    }
  }
  const storeToken = (value) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, value)
    } catch {
      /* mémoire de l’onglet uniquement */
    }
  }
  const clearToken = () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY)
    } catch {
      /* rien à faire */
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${state.token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      cache: 'no-store',
      credentials: 'omit',
    })
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      /* réponse non JSON */
    }
    if (response.status === 401) {
      signOut(true)
      const error = new Error('unauthorized')
      error.code = 'unauthorized'
      throw error
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

  const openApp = () => {
    authGate.hidden = true
    app.hidden = false
    logoutButton.hidden = false
    authError.hidden = true
  }
  function signOut(expired = false) {
    state.token = ''
    clearToken()
    app.hidden = true
    authGate.hidden = false
    logoutButton.hidden = true
    authSubmit.disabled = false
    tokenInput.value = ''
    authError.textContent = expired ? 'Jeton refusé ou expiré. Vérifie ton accès.' : ''
    authError.hidden = !expired
    window.setTimeout(() => tokenInput.focus(), 0)
  }

  const setBusy = (busy) => {
    state.loading = busy
    refreshButton.disabled = busy
    app.classList.toggle('console-loading', busy)
  }

  const commonRequests = () => [
    request('/api/admin/me'),
    request('/api/admin/overview'),
    request('/api/admin/manual-orders'),
    request('/api/admin/stock'),
    request('/api/admin/tickets'),
    request('/api/admin/canned-responses'),
    request('/api/admin/promo-codes'),
  ]

  async function loadAll({ silent = false } = {}) {
    if (!state.token || state.loading) return
    setBusy(true)
    if (!silent) setNotice('')
    try {
      const results = await Promise.allSettled(commonRequests())
      if (!state.token) return
      const labels = ['Profil', 'Analytics', 'Commandes', 'Stock', 'Tickets', 'Réponses', 'Promos']
      const errors = []
      results.forEach((result, index) => {
        if (result.status === 'rejected' && result.reason?.code !== 'unauthorized') {
          errors.push(`${labels[index]} : ${errorLabel(result.reason)}`)
        }
      })

      if (results[0].status === 'fulfilled') {
        state.me = results[0].value.staff
        setText('staff-name', state.me?.name || 'Staff')
        setText('staff-role', state.me?.role || '—')
        document.querySelectorAll('[data-admin-only]').forEach((element) => {
          element.hidden = state.me?.role !== 'admin'
        })
      }
      if (results[1].status === 'fulfilled') state.overview = results[1].value
      if (results[2].status === 'fulfilled') state.orders = results[2].value.orders || []
      if (results[3].status === 'fulfilled') state.stock = results[3].value.products || []
      if (results[4].status === 'fulfilled') state.tickets = results[4].value.tickets || []
      if (results[5].status === 'fulfilled') state.canned = results[5].value.responses || []
      if (results[6].status === 'fulfilled') state.promos = results[6].value.codes || []

      if (state.me?.role === 'admin') {
        const adminResults = await Promise.allSettled([
          request('/api/admin/audit'),
          request('/api/admin/blacklist'),
          request('/api/admin/staff'),
        ])
        if (adminResults[0].status === 'fulfilled') state.audit = adminResults[0].value.logs || []
        if (adminResults[1].status === 'fulfilled') state.blacklist = adminResults[1].value.entries || []
        if (adminResults[2].status === 'fulfilled') state.staff = adminResults[2].value.staff || []
      } else {
        state.audit = []
        state.blacklist = []
        state.staff = []
      }

      state.lastUpdated = new Date()
      renderAll()
      if (errors.length) setNotice(errors.join(' '), 'error')
    } catch (error) {
      if (error.code !== 'unauthorized') setNotice(errorLabel(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const renderAll = () => {
    renderOverview()
    renderOrders()
    renderStock()
    renderTickets()
    renderCanned()
    renderPromos()
    renderSecurity()
    if (state.lastUpdated) {
      setText('last-updated', `Actualisé à ${clock.format(state.lastUpdated)}`)
      $('last-updated').title = fullDate.format(state.lastUpdated)
    }
  }

  const renderOverview = () => {
    const data = state.overview
    if (!data) return
    setText('kpi-revenue-day', money(data.kpis?.revenueDay))
    setText('kpi-revenue-week', money(data.kpis?.revenueWeek))
    setText('kpi-revenue-month', money(data.kpis?.revenueMonth))
    setText('kpi-conversion', `${Number(data.kpis?.conversion || 0).toFixed(1)} %`)
    setText('kpi-orders', data.kpis?.totalOrders ?? 0)
    setText('kpi-tickets', data.kpis?.openTickets ?? 0)
    setText('kpi-stock', data.kpis?.lowStock ?? 0)
    setText('kpi-delivered', data.kpis?.counts?.delivered ?? 0)
    setText('kpi-orders-note', `${data.kpis?.counts?.pending ?? 0} à vérifier`)

    const chart = $('category-chart')
    const categories = Array.isArray(data.categories) ? data.categories : []
    chart.replaceChildren()
    $('category-empty').hidden = categories.length !== 0
    const max = Math.max(1, ...categories.map((category) => Number(category.revenueCents) || 0))
    categories.forEach((category) => {
      const row = document.createElement('div')
      row.className = 'console-bar'
      row.innerHTML = `<div class="console-bar__head"><span>${esc(category.name)}</span><span>${money(category.revenueCents)} · ${category.count} vente(s)</span></div><div class="console-bar__track"><div class="console-bar__fill" style="width:${Math.max(3, Math.round((Number(category.revenueCents) / max) * 100))}%"></div></div>`
      chart.append(row)
    })

    const low = Array.isArray(data.lowStock) ? data.lowStock : []
    const lowList = $('low-stock-list')
    lowList.replaceChildren()
    $('low-stock-empty').hidden = low.length !== 0
    low.forEach((product) => {
      const available = Number(product.available_keys) || 0
      const declared = Number(product.stock) || 0
      const effective = available > 0 ? available : declared
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(product.name || product.slug)}</strong><small>seuil ${product.low_stock_threshold ?? 3} · ${esc(product.category || 'sans catégorie')}</small></div><span class="console-tag" data-status="dispute">${effective} restant(s)</span>`
      lowList.append(row)
    })

    const recentOrders = $('recent-orders')
    recentOrders.replaceChildren()
    ;(data.recentOrders || []).forEach((order) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'console-list__row'
      row.style.width = '100%'
      row.style.border = '0'
      row.style.background = 'transparent'
      row.style.color = 'inherit'
      row.style.cursor = 'pointer'
      row.dataset.orderId = order.order_id
      row.innerHTML = `<div style="text-align:left"><strong>${esc(order.order_id)}</strong><small>${fmtDate(order.created_at)}</small></div><div style="text-align:right"><strong>${money(order.total_cents)}</strong><small>${esc(statusLabel(order.workflow_status))}</small></div>`
      recentOrders.append(row)
    })

    const auditList = $('recent-audit')
    auditList.replaceChildren()
    ;(data.recentAudit || []).forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(entry.actor_name || 'Staff')}</strong><small>${esc(entry.action)}${entry.target_id ? ` · ${esc(entry.target_id)}` : ''}</small></div><span class="console-muted">${fmtShort(entry.created_at)}</span>`
      auditList.append(row)
    })
  }

  const statusTag = (status) =>
    `<span class="console-tag" data-status="${esc(status || 'unknown')}">${esc(statusLabel(status))}</span>`

  const renderOrders = () => {
    const query = state.query.trim().toLowerCase()
    const filtered = state.orders.filter((order) => {
      if (state.filter !== 'all' && order.workflow_status !== state.filter) return false
      if (!query) return true
      return [order.order_id, order.discord, order.paypal_ref, order.note, order.promo_code]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
    const counts = { all: state.orders.length }
    ;['pending', 'paid', 'delivered', 'dispute', 'cancelled'].forEach((status) => {
      counts[status] = state.orders.filter((order) => order.workflow_status === status).length
    })
    document.querySelectorAll('#order-status-filters [data-status]').forEach((button) => {
      const key = button.dataset.status
      button.classList.toggle('is-active', key === state.filter)
      const count = button.querySelector('[data-count]')
      if (count) count.textContent = String(counts[key] || 0)
    })

    const body = $('orders-body')
    body.replaceChildren()
    filtered.forEach((order) => {
      const row = document.createElement('tr')
      const status = order.workflow_status
      const actionButtons = [
        status === 'pending' ? `<button class="console-btn console-btn--sm console-btn--primary" type="button" data-order-id="${esc(order.order_id)}" data-order-action="paid">Valider</button>` : '',
        status === 'paid' || status === 'pending'
          ? `<button class="console-btn console-btn--sm console-btn--green" type="button" data-order-id="${esc(order.order_id)}" data-order-action="delivered">Livrer</button>`
          : '',
        `<button class="console-btn console-btn--sm" type="button" data-order-id="${esc(order.order_id)}" data-order-action="detail">Détails</button>`,
      ].join('')
      row.innerHTML = `
        <td><code>${esc(order.order_id)}</code><div class="console-muted" style="margin-top:4px">${fmtDate(order.created_at)}</div></td>
        <td><span class="strong">@${esc(order.discord || '—')}</span>${order.note ? `<div class="console-muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(order.note)}">${esc(order.note)}</div>` : ''}</td>
        <td>${money(order.total_cents, order.currency)}${Number(order.discount_cents) > 0 ? `<div class="console-muted">−${money(order.discount_cents, order.currency)}</div>` : ''}</td>
        <td><code>${esc(order.paypal_ref || '—')}</code></td>
        <td>${statusTag(status)}</td>
        <td><div class="console-actions">${actionButtons}</div></td>`
      body.append(row)
    })
    $('orders-empty').hidden = filtered.length !== 0
    setText('orders-count', `${filtered.length} commande(s) affichée(s) sur ${state.orders.length}`)
  }

  const renderOrderDetail = (data) => {
    const order = data.order || {}
    const items = parseItems(order)
    const events = data.events || []
    const keys = data.keys || []
    const tickets = data.tickets || []
    setText('order-detail-title', order.order_id || 'Commande')
    const content = $('order-detail-content')
    content.innerHTML = `
      <div class="console-detail-grid">
        <div class="console-detail"><span>Client</span><strong>@${esc(order.discord || '—')}</strong></div>
        <div class="console-detail"><span>Statut</span><strong>${statusTag(order.workflow_status)}</strong></div>
        <div class="console-detail"><span>Total</span><strong>${money(order.total_cents, order.currency)}</strong></div>
        <div class="console-detail"><span>PayPal</span><strong><code>${esc(order.paypal_ref || '—')}</code></strong></div>
        <div class="console-detail"><span>Créée le</span><strong>${fmtDate(order.created_at)}</strong></div>
        <div class="console-detail"><span>Promo</span><strong>${esc(order.promo_code || '—')}${Number(order.discount_cents) > 0 ? ` · −${money(order.discount_cents, order.currency)}` : ''}</strong></div>
      </div>
      ${order.note ? `<p class="console-note">Note client : ${esc(order.note)}</p>` : ''}
      <h3 style="margin:18px 0 8px;font:600 13px Inter">Articles</h3>
      <ul class="console-list">${items.map((item) => `<li class="console-list__row"><span>${esc(item.name)} ×${item.quantity}</span><strong>${money(item.amountCents * item.quantity, order.currency)}</strong></li>`).join('') || '<li class="console-muted">Aucun article.</li>'}</ul>
      <h3 style="margin:18px 0 8px;font:600 13px Inter">Clés livrées</h3>
      <div class="console-keys">${keys.length ? keys.map((key) => `<div class="console-key"><span>${esc(key.secret)}</span><span class="console-muted">${esc(key.status)}</span></div>`).join('') : '<p class="console-muted">Aucune clé associée.</p>'}</div>
      <h3 style="margin:18px 0 8px;font:600 13px Inter">Tickets liés</h3>
      <div class="console-list">${tickets.length ? tickets.map((ticket) => `<div class="console-list__row"><span>${esc(ticket.subject)}</span>${statusTag(ticket.status)}</div>`).join('') : '<p class="console-muted">Aucun ticket.</p>'}</div>
      <h3 style="margin:18px 0 8px;font:600 13px Inter">Historique</h3>
      <ul class="console-timeline">${events.length ? events.map((event) => `<li>${esc(event.type)}${event.to_status ? ` → ${esc(event.to_status)}` : ''}<span>${fmtDate(event.created_at)} · ${esc(event.actor || 'système')}${event.note ? ` · ${esc(event.note)}` : ''}</span></li>`).join('') : '<li>Aucun événement.</li>'}</ul>
      <div class="console-actions" style="margin-top:20px">
        <button class="console-btn console-btn--primary" type="button" data-detail-status="paid">Marquer payée</button>
        <button class="console-btn console-btn--green" type="button" data-detail-deliver="keys">Livrer avec les clés</button>
        <button class="console-btn" type="button" data-detail-deliver="manual">Marquer livrée</button>
        <button class="console-btn console-btn--danger" type="button" data-detail-status="dispute">Litige</button>
        <button class="console-btn console-btn--danger" type="button" data-detail-status="cancelled">Annuler</button>
      </div>`
  }

  async function openOrder(orderId) {
    try {
      const data = await request(`/api/admin/manual-orders/${encodeURIComponent(orderId)}`)
      drawer.hidden = false
      renderOrderDetail(data)
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  }

  const closeOrder = () => {
    drawer.hidden = true
    $('order-detail-content').replaceChildren()
  }

  async function changeStatus(orderId, status) {
    try {
      await request(`/api/admin/manual-orders/${encodeURIComponent(orderId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
      showToast(`Commande ${orderId} : ${statusLabel(status)}.`)
      await loadAll({ silent: true })
      if (!drawer.hidden) await openOrder(orderId)
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  }

  async function deliverOrder(orderId, mode) {
    try {
      const result = await request(`/api/admin/manual-orders/${encodeURIComponent(orderId)}/deliver`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      })
      showToast(`Commande ${orderId} livrée${result.keysAllocated ? ` (${result.keysAllocated} clé(s))` : ''}.`)
      await loadAll({ silent: true })
      if (!drawer.hidden) await openOrder(orderId)
    } catch (error) {
      if (error.code === 'insufficient_keys') {
        const missing = (error.payload?.missing || []).map((item) => item.slug).join(', ')
        showToast(`Clés insuffisantes${missing ? ` : ${missing}` : ''}.`, 'error')
      } else if (error.code !== 'unauthorized') {
        showToast(errorLabel(error), 'error')
      }
    }
  }

  const renderStock = () => {
    const body = $('stock-list')
    body.replaceChildren()
    const select = $('keys-product')
    const selected = select.value
    select.innerHTML = state.stock
      .map((product) => `<option value="${esc(product.slug)}">${esc(product.name || product.slug)}</option>`)
      .join('')
    if (selected) select.value = selected
    state.stock.forEach((product) => {
      const row = document.createElement('tr')
      const available = Number(product.available_keys) || 0
      const declared = Number(product.stock) || 0
      row.innerHTML = `
        <td><code>${esc(product.slug)}</code><div class="console-muted">${esc(product.name || '')}</div></td>
        <td>${esc(product.category || '—')}</td>
        <td>${product.price_cents == null ? '—' : money(product.price_cents)}</td>
        <td>${declared}</td>
        <td>${available}</td>
        <td>${product.low_stock_threshold ?? 3}</td>
        <td><div class="console-actions"><button class="console-btn console-btn--sm" type="button" data-edit-stock="${esc(product.slug)}">Modifier</button><button class="console-btn console-btn--sm" type="button" data-view-keys="${esc(product.slug)}">Clés</button></div></td>`
      body.append(row)
    })
    $('stock-empty').hidden = state.stock.length !== 0
  }

  const editStock = (slug) => {
    const product = state.stock.find((row) => row.slug === slug)
    if (!product) return
    $('stock-slug').value = product.slug || ''
    $('stock-name').value = product.name || ''
    $('stock-category').value = product.category || ''
    $('stock-price').value = product.price_cents == null ? '' : (Number(product.price_cents) / 100).toFixed(2)
    $('stock-stock').value = product.stock ?? 0
    $('stock-threshold').value = product.low_stock_threshold ?? 3
    $('stock-active').checked = Number(product.active) === 1
    $('stock-form-title').textContent = `Modifier ${product.name || product.slug}`
    $('stock-slug').focus()
  }

  const renderKeys = (keys, slug) => {
    $('keys-card').hidden = false
    setText('keys-title', `Clés · ${slug}`)
    const list = $('keys-list')
    list.replaceChildren()
    if (!keys.length) {
      list.innerHTML = '<p class="console-muted">Aucune clé pour ce produit.</p>'
      return
    }
    keys.forEach((key) => {
      const row = document.createElement('div')
      row.className = 'console-key'
      row.innerHTML = `<span>${esc(key.secret)}</span><span class="console-muted">${esc(key.status)}${key.order_id ? ` · ${esc(key.order_id)}` : ''}</span>${key.status === 'available' ? `<button class="console-btn console-btn--sm console-btn--danger" type="button" data-disable-key="${esc(key.id)}" data-key-slug="${esc(slug)}">Désactiver</button>` : ''}`
      list.append(row)
    })
  }

  async function viewKeys(slug) {
    try {
      const data = await request(`/api/admin/stock/${encodeURIComponent(slug)}/keys`)
      renderKeys(data.keys || [], slug)
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  }

  const renderTickets = () => {
    const list = $('ticket-list')
    list.replaceChildren()
    setText('ticket-count', state.tickets.length)
    $('ticket-empty').hidden = state.tickets.length !== 0
    state.tickets.forEach((ticket) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `console-ticket${ticket.id === state.selectedTicketId ? ' is-active' : ''}`
      button.dataset.ticketId = ticket.id
      button.innerHTML = `<strong>${esc(ticket.subject)}</strong><small>@${esc(ticket.discord)} · ${fmtShort(ticket.last_message_at || ticket.updated_at)}</small><div class="console-ticket__meta">${statusTag(ticket.status)}<span class="console-muted">${esc(ticket.assignee || 'non assigné')}</span></div>`
      list.append(button)
    })
  }

  const renderCanned = () => {
    const select = $('ticket-canned')
    select.innerHTML = '<option value="">Modèle de réponse…</option>' + state.canned
      .map((response) => `<option value="${esc(response.id)}">${esc(response.title)}</option>`)
      .join('')
    const list = $('canned-list')
    list.replaceChildren()
    state.canned.forEach((response) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(response.title)}</strong><small>${esc(response.body.slice(0, 70))}${response.body.length > 70 ? '…' : ''}</small></div><button class="console-btn console-btn--sm" type="button" data-delete-canned="${esc(response.id)}">Supprimer</button>`
      list.append(row)
    })
  }

  const renderThread = () => {
    const ticket = state.selectedTicket
    const empty = $('ticket-thread-empty')
    const thread = $('ticket-thread')
    if (!ticket) {
      empty.hidden = false
      thread.hidden = true
      return
    }
    empty.hidden = true
    thread.hidden = false
    setText('ticket-subject', ticket.subject)
    setText('ticket-meta', `@${ticket.discord} · commande ${ticket.order_id} · ${ticket.assignee || 'non assigné'}`)
    const tag = $('ticket-status-tag')
    tag.textContent = statusLabel(ticket.status)
    tag.dataset.status = ticket.status
    $('ticket-status').value = ticket.status
    $('ticket-assignee').value = ticket.assignee || ''
    const messages = $('ticket-messages')
    messages.replaceChildren()
    ;(ticket.messages || []).forEach((message) => {
      const row = document.createElement('div')
      row.className = `console-message${message.author_type === 'staff' ? ' console-message--staff' : ''}`
      row.innerHTML = `<small>${esc(message.author_name || message.author_type)}</small><p>${esc(message.body)}</p><time>${fmtDate(message.created_at)}</time>`
      messages.append(row)
    })
    messages.scrollTop = messages.scrollHeight
  }

  async function selectTicket(ticketId) {
    try {
      const data = await request(`/api/admin/tickets/${encodeURIComponent(ticketId)}`)
      state.selectedTicketId = ticketId
      state.selectedTicket = { ...data.ticket, messages: data.messages || [] }
      renderTickets()
      renderThread()
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  }

  const renderSecurity = () => {
    const isAdmin = state.me?.role === 'admin'
    $('security-admin-note').hidden = isAdmin
    const auditList = $('audit-list')
    auditList.replaceChildren()
    state.audit.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(entry.actor_name)}</strong><small>${esc(entry.action)} · ${esc(entry.target_type || '')} ${esc(entry.target_id || '')} · ${fmtDate(entry.created_at)}</small></div><span class="console-muted">${esc(entry.ip_hash ? entry.ip_hash.slice(0, 8) + '…' : '')}</span>`
      auditList.append(row)
    })
    if (!state.audit.length) auditList.innerHTML = '<p class="console-muted">Aucun log accessible.</p>'

    const blacklist = $('blacklist-list')
    blacklist.replaceChildren()
    state.blacklist.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(entry.kind)} · ${esc(entry.value_masked)}</strong><small>${esc(entry.reason || 'sans motif')} · ${esc(entry.created_by)}</small></div><button class="console-btn console-btn--sm" type="button" data-toggle-blacklist="${esc(entry.id)}" data-active="${Number(entry.active) === 1 ? '1' : '0'}">${Number(entry.active) === 1 ? 'Débloquer' : 'Réactiver'}</button>`
      blacklist.append(row)
    })
    if (!state.blacklist.length) blacklist.innerHTML = '<p class="console-muted">Aucune entrée.</p>'

    const staff = $('staff-list')
    staff.replaceChildren()
    state.staff.forEach((member) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      row.innerHTML = `<div><strong>${esc(member.name)}</strong><small>${esc(member.role)} · ${Number(member.active) === 1 ? 'actif' : 'désactivé'} · ${member.last_seen_at ? `vu ${fmtShort(member.last_seen_at)}` : 'jamais connecté'}</small></div>${member.id !== state.me?.id ? `<button class="console-btn console-btn--sm" type="button" data-toggle-staff="${esc(member.id)}" data-active="${Number(member.active) === 1 ? '1' : '0'}">${Number(member.active) === 1 ? 'Désactiver' : 'Activer'}</button>` : '<span class="console-muted">toi</span>'}`
      staff.append(row)
    })
    if (!state.staff.length) staff.innerHTML = '<p class="console-muted">Aucun compte staff.</p>'
  }

  const renderPromos = () => {
    const list = $('promos-list')
    list.replaceChildren()
    $('promos-empty').hidden = state.promos.length !== 0
    state.promos.forEach((promo) => {
      const row = document.createElement('div')
      row.className = 'console-list__row'
      const discount = Number(promo.percent_off) > 0 ? `${promo.percent_off} %` : money(promo.amount_off_cents)
      row.innerHTML = `<div><strong>${esc(promo.code)} · ${discount}</strong><small>${promo.uses}${promo.max_uses ? ` / ${promo.max_uses}` : ''} utilisation(s) · ${promo.expires_at ? `expire ${fmtShort(promo.expires_at)}` : 'sans expiration'}</small></div><button class="console-btn console-btn--sm" type="button" data-promo-toggle="${esc(promo.code)}" data-active="${Number(promo.active) === 1 ? '1' : '0'}">${Number(promo.active) === 1 ? 'Désactiver' : 'Activer'}</button>`
      list.append(row)
    })
  }

  const setTab = (tab) => {
    const button = document.querySelector(`#console-nav [data-tab="${tab}"]`)
    if (!button) return
    if (tab === 'security' && state.me?.role !== 'admin') return
    state.tab = tab
    document.querySelectorAll('#console-nav [data-tab]').forEach((item) => item.classList.toggle('is-active', item === button))
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab
    })
    setText('panel-title', button.dataset.title || '')
    setText('panel-subtitle', button.dataset.subtitle || '')
  }

  const setFormError = (id, message) => {
    const element = $(id)
    if (!element) return
    element.textContent = message || ''
    element.hidden = !message
  }

  // ------------------------------------------------------------------ events
  authForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const token = tokenInput.value.trim()
    if (!token) {
      authError.textContent = 'Entre un jeton pour continuer.'
      authError.hidden = false
      return
    }
    state.token = token
    storeToken(token)
    authSubmit.disabled = true
    openApp()
    await loadAll()
    authSubmit.disabled = false
  })

  logoutButton.addEventListener('click', () => signOut(false))
  refreshButton.addEventListener('click', () => loadAll())
  $('console-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]')
    if (button) setTab(button.dataset.tab)
  })
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go-tab]')
    if (go) setTab(go.dataset.goTab)
  })

  $('orders-search').addEventListener('input', () => {
    state.query = $('orders-search').value
    renderOrders()
  })
  $('order-status-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]')
    if (!button) return
    state.filter = button.dataset.status
    renderOrders()
  })
  $('orders-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-order-action]')
    if (button) {
      const { orderId, orderAction } = button.dataset
      if (orderAction === 'detail') openOrder(orderId)
      else if (orderAction === 'paid') changeStatus(orderId, 'paid')
      else if (orderAction === 'delivered') deliverOrder(orderId, 'keys')
      return
    }
    const row = event.target.closest('[data-order-id]')
    if (row && !event.target.closest('button')) openOrder(row.dataset.orderId)
  })
  $('recent-orders').addEventListener('click', (event) => {
    const row = event.target.closest('[data-order-id]')
    if (row) openOrder(row.dataset.orderId)
  })
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-order]')) {
      closeOrder()
      return
    }
    const status = event.target.closest('[data-detail-status]')
    if (status) {
      changeStatus($('order-detail-title').textContent, status.dataset.detailStatus)
      return
    }
    const deliver = event.target.closest('[data-detail-deliver]')
    if (deliver) deliverOrder($('order-detail-title').textContent, deliver.dataset.detailDeliver)
  })

  $('stock-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setFormError('stock-error', '')
    const payload = {
      slug: $('stock-slug').value.trim(),
      name: $('stock-name').value.trim(),
      category: $('stock-category').value.trim(),
      priceCents: Math.round((Number.parseFloat($('stock-price').value || '0') || 0) * 100),
      stock: Number.parseInt($('stock-stock').value || '0', 10),
      lowStockThreshold: Number.parseInt($('stock-threshold').value || '3', 10),
      active: $('stock-active').checked,
    }
    $('stock-submit').disabled = true
    try {
      await request('/api/admin/stock', { method: 'POST', body: JSON.stringify(payload) })
      showToast(`Stock de ${payload.slug} enregistré.`)
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') setFormError('stock-error', errorLabel(error))
    } finally {
      $('stock-submit').disabled = false
    }
  })

  $('keys-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setFormError('keys-error', '')
    const slug = $('keys-product').value
    const text = $('keys-text').value
    if (!slug || !text.trim()) {
      setFormError('keys-error', 'Choisis un produit et colle au moins une clé.')
      return
    }
    $('keys-submit').disabled = true
    try {
      const data = await request(`/api/admin/stock/${encodeURIComponent(slug)}/keys`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      $('keys-text').value = ''
      showToast(`Import : ${data.inserted} clé(s) ajoutée(s), ${data.skipped} ignorée(s).`)
      await loadAll({ silent: true })
      await viewKeys(slug)
    } catch (error) {
      if (error.code !== 'unauthorized') setFormError('keys-error', errorLabel(error))
    } finally {
      $('keys-submit').disabled = false
    }
  })

  $('stock-list').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-stock]')
    if (edit) editStock(edit.dataset.editStock)
    const keys = event.target.closest('[data-view-keys]')
    if (keys) viewKeys(keys.dataset.viewKeys)
  })
  $('keys-close').addEventListener('click', () => {
    $('keys-card').hidden = true
  })
  $('keys-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-disable-key]')
    if (!button) return
    try {
      await request(`/api/admin/stock/${encodeURIComponent(button.dataset.keySlug)}/keys/${encodeURIComponent(button.dataset.disableKey)}/disable`, { method: 'POST' })
      showToast('Clé désactivée.')
      await viewKeys(button.dataset.keySlug)
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })

  $('ticket-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ticket-id]')
    if (button) selectTicket(button.dataset.ticketId)
  })
  $('ticket-canned').addEventListener('change', () => {
    const response = state.canned.find((entry) => entry.id === $('ticket-canned').value)
    if (response) $('ticket-reply').value = response.body
  })
  $('ticket-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!state.selectedTicket) return
    const message = $('ticket-reply').value.trim()
    if (!message) return
    $('ticket-send').disabled = true
    try {
      await request(`/api/admin/tickets/${encodeURIComponent(state.selectedTicket.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      })
      $('ticket-reply').value = ''
      await selectTicket(state.selectedTicket.id)
      await loadAll({ silent: true })
      showToast('Réponse envoyée.')
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    } finally {
      $('ticket-send').disabled = false
    }
  })
  $('ticket-status').addEventListener('change', async () => {
    if (!state.selectedTicket) return
    try {
      await request(`/api/admin/tickets/${encodeURIComponent(state.selectedTicket.id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: $('ticket-status').value }),
      })
      await selectTicket(state.selectedTicket.id)
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })
  $('ticket-assign').addEventListener('click', async () => {
    if (!state.selectedTicket) return
    try {
      await request(`/api/admin/tickets/${encodeURIComponent(state.selectedTicket.id)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignee: $('ticket-assignee').value.trim() }),
      })
      await selectTicket(state.selectedTicket.id)
      await loadAll({ silent: true })
      showToast('Ticket assigné.')
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })
  $('canned-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const title = $('canned-title').value.trim()
    const body = $('canned-body').value.trim()
    if (!title || !body) return
    try {
      await request('/api/admin/canned-responses', { method: 'POST', body: JSON.stringify({ title, body }) })
      $('canned-title').value = ''
      $('canned-body').value = ''
      await loadAll({ silent: true })
      showToast('Modèle ajouté.')
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })
  $('canned-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-canned]')
    if (!button) return
    try {
      await request(`/api/admin/canned-responses/${encodeURIComponent(button.dataset.deleteCanned)}`, { method: 'DELETE' })
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })

  $('blacklist-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setFormError('blacklist-error', '')
    try {
      await request('/api/admin/blacklist', {
        method: 'POST',
        body: JSON.stringify({
          kind: $('blacklist-kind').value,
          value: $('blacklist-value').value.trim(),
          reason: $('blacklist-reason').value.trim(),
        }),
      })
      $('blacklist-value').value = ''
      $('blacklist-reason').value = ''
      await loadAll({ silent: true })
      showToast('Entrée ajoutée à la liste noire.')
    } catch (error) {
      if (error.code !== 'unauthorized') setFormError('blacklist-error', errorLabel(error))
    }
  })
  $('blacklist-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-toggle-blacklist]')
    if (!button) return
    try {
      await request(`/api/admin/blacklist/${encodeURIComponent(button.dataset.toggleBlacklist)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ active: button.dataset.active !== '1' }),
      })
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })
  $('staff-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setFormError('staff-error', '')
    try {
      const data = await request('/api/admin/staff', {
        method: 'POST',
        body: JSON.stringify({ name: $('staff-name-input').value.trim(), role: $('staff-role-input').value }),
      })
      const box = $('staff-token')
      box.hidden = false
      box.querySelector('span').textContent = data.token
      box.querySelector('button').dataset.token = data.token
      $('staff-name-input').value = ''
      await loadAll({ silent: true })
      showToast('Accès staff créé. Copie le jeton maintenant.')
    } catch (error) {
      if (error.code !== 'unauthorized') setFormError('staff-error', errorLabel(error))
    }
  })
  $('staff-token').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-token]')
    if (!button) return
    try {
      await navigator.clipboard.writeText(button.dataset.token || '')
      showToast('Jeton copié.')
    } catch {
      showToast('Copie indisponible.', 'error')
    }
  })
  $('staff-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-toggle-staff]')
    if (!button) return
    try {
      await request(`/api/admin/staff/${encodeURIComponent(button.dataset.toggleStaff)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ active: button.dataset.active !== '1' }),
      })
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })

  $('promo-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    setFormError('promo-error', '')
    const code = $('promo-code').value.trim().toUpperCase()
    const percent = Number.parseInt($('promo-percent').value || '0', 10)
    const maxRaw = $('promo-max').value.trim()
    const min = Number.parseFloat($('promo-min').value || '0')
    const expiry = $('promo-expiry').value
    try {
      await request('/api/admin/promo-codes', {
        method: 'POST',
        body: JSON.stringify({
          code,
          percentOff: percent,
          amountOffCents: 0,
          minTotalCents: Math.round((Number.isFinite(min) ? min : 0) * 100),
          maxUses: maxRaw ? Number.parseInt(maxRaw, 10) : null,
          expiresAt: expiry ? new Date(`${expiry}T23:59:59Z`).toISOString() : null,
          active: true,
        }),
      })
      $('promo-form').reset()
      $('promo-percent').value = '10'
      $('promo-min').value = '0'
      await loadAll({ silent: true })
      showToast(`Code ${code} enregistré.`)
    } catch (error) {
      if (error.code !== 'unauthorized') setFormError('promo-error', errorLabel(error))
    }
  })
  $('promos-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-promo-toggle]')
    if (!button) return
    try {
      await request(`/api/admin/promo-codes/${encodeURIComponent(button.dataset.promoToggle)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ active: button.dataset.active !== '1' }),
      })
      await loadAll({ silent: true })
    } catch (error) {
      if (error.code !== 'unauthorized') showToast(errorLabel(error), 'error')
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token && !state.loading) loadAll({ silent: true })
  })
  window.setInterval(() => {
    if (state.token && !state.loading && document.visibilityState === 'visible') loadAll({ silent: true })
  }, REFRESH_MS)

  // -------------------------------------------------------------------- init
  app.hidden = true
  authGate.hidden = false
  logoutButton.hidden = true
  const saved = readToken()
  if (saved) {
    state.token = saved
    openApp()
    loadAll()
  } else {
    tokenInput.focus()
  }
})()
