// Panier + achat : ajout depuis la fiche produit, tiroir persistant (localStorage),
// quantités, suppression et paiement (Stripe ou PayPal). Les prix affichés
// viennent du serveur (`/api/prices`) ; le montant facturé est recalculé côté
// serveur à partir du catalogue, jamais depuis le navigateur.
(() => {
  const match = location.pathname.match(/^\/product\/([a-z0-9-]+)\/?$/)
  if (!match) return

  const slug = match[1]
  const CART_KEY = 'ego-cart-v1'
  const MAX_ITEMS = 10
  const MAX_QTY = 10
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
  const euro = (cents) => `${(cents / 100).toFixed(2)} €`

  const messages = {
    checkout_unavailable: 'Le paiement par carte n’est pas encore activé.',
    paypal_unavailable: 'PayPal n’est pas encore activé.',
    checkout_failed: 'Le paiement n’a pas pu démarrer. Réessayez.',
    unknown_product: 'Produit introuvable.',
    invalid_product: 'Produit introuvable.',
    invalid_cart: 'Le panier est invalide. Videz-le et réessayez.',
    cart_too_large: 'Le panier est limité à 10 produits.',
    paypal_cart_unsupported: 'Avec PayPal, le panier ne peut contenir qu’un seul produit.',
  }

  // ------------------------------------------------------------------ panier
  let prices = null
  const priceOf = (itemSlug) => (prices && prices[itemSlug] ? prices[itemSlug].amountCents : null)
  const nameOf = (itemSlug) => (prices && prices[itemSlug] ? prices[itemSlug].name : itemSlug)

  const readCart = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]')
      if (!Array.isArray(raw)) return []
      return raw
        .filter((row) => row && typeof row.slug === 'string' && SLUG_RE.test(row.slug))
        .map((row) => ({
          slug: row.slug,
          quantity: Math.min(Math.max(Number.parseInt(row.quantity, 10) || 1, 1), MAX_QTY),
        }))
        .slice(0, MAX_ITEMS)
    } catch {
      return []
    }
  }

  let cart = readCart()
  const count = () => cart.reduce((sum, item) => sum + item.quantity, 0)
  const totalCents = () => cart.reduce((sum, item) => sum + (priceOf(item.slug) || 0) * item.quantity, 0)
  const save = () => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart))
    } catch {
      /* stockage indisponible : le panier reste en mémoire */
    }
  }

  const purchaseButtons = [...document.querySelectorAll('button')].filter((button) =>
    /^\s*purchase\s*$/i.test((button.textContent || '').trim()),
  )
  const addButton = [...document.querySelectorAll('button')].find((button) =>
    /^\s*add to cart\s*$/i.test((button.textContent || '').trim()),
  )
  const cartButton = [...document.querySelectorAll('button')].find((button) =>
    /^cart\b/i.test((button.getAttribute('aria-label') || '').trim()),
  )
  const qtyInput = document.getElementById('lxv-qty')
  const quantity = () => {
    const parsed = Number.parseInt((qtyInput && qtyInput.value) || '1', 10)
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_QTY) : 1
  }

  const requestCheckout = async (provider, body) => {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, provider }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.url) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }

  // Carte affichée pour un paiement PayPal.Me : montant + référence à recopier.
  const paypalMeCard = (data) => {
    const card = document.createElement('div')
    card.className = 'ego-pay__confirm'

    const amount = document.createElement('p')
    amount.className = 'ego-pay__note'
    amount.textContent = `Montant à payer : ${data.amountLabel}.`

    const reference = document.createElement('p')
    reference.className = 'ego-pay__note'
    reference.append('Référence de commande : ')
    const ref = document.createElement('strong')
    ref.className = 'ego-pay__ref'
    ref.textContent = data.orderId
    reference.appendChild(ref)

    const tip = document.createElement('p')
    tip.className = 'ego-pay__note'
    tip.textContent =
      'Indiquez cette référence dans la note PayPal : elle permet de retrouver votre paiement et d’ouvrir le droit à un avis vérifié.'

    const go = document.createElement('a')
    go.className = 'ego-pay__go'
    go.href = data.url
    go.target = '_blank'
    go.rel = 'noopener noreferrer'
    go.textContent = 'Ouvrir PayPal'

    card.append(amount, reference, tip, go)
    return card
  }

  const makeProviderButton = (provider, title, hint, handler) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ego-pay__btn'
    button.dataset.provider = provider

    const main = document.createElement('span')
    main.textContent = title
    const sub = document.createElement('span')
    sub.className = 'ego-pay__hint'
    sub.textContent = hint

    button.append(main, sub)
    button.addEventListener('click', () => handler(provider, button))
    return button
  }

  const methods = [
    { provider: 'stripe', title: 'Carte bancaire', hint: 'Stripe' },
    { provider: 'paypal', title: 'PayPal', hint: 'Compte PayPal' },
  ]

  // --------------------------------------------------------- achat immédiat
  const payPanel = document.createElement('div')
  payPanel.className = 'ego-pay'
  payPanel.hidden = true

  const payLabel = document.createElement('span')
  payLabel.className = 'ego-pay__label'
  payLabel.textContent = 'Moyen de paiement'
  payPanel.appendChild(payLabel)

  const payStatus = document.createElement('p')
  payStatus.className = 'ego-pay__status'
  payStatus.hidden = true
  payPanel.appendChild(payStatus)

  const setPayStatus = (text, tone) => {
    payStatus.textContent = text || ''
    payStatus.dataset.tone = tone || ''
    payStatus.hidden = !text
  }

  const startPurchase = async (provider, trigger) => {
    payPanel.querySelectorAll('.ego-pay__btn').forEach((button) => {
      button.disabled = true
    })
    setPayStatus('Redirection…', 'info')
    try {
      const data = await requestCheckout(provider, { slug, quantity: quantity() })
      if (data.mode === 'paypal_me') {
        const previous = payPanel.querySelector('.ego-pay__confirm')
        if (previous) previous.remove()
        payPanel.appendChild(paypalMeCard(data))
        setPayStatus('', '')
        payPanel.querySelectorAll('.ego-pay__btn').forEach((button) => {
          button.disabled = false
        })
        return
      }
      location.href = data.url
    } catch (error) {
      const key = error instanceof Error ? error.message : ''
      setPayStatus(messages[key] || 'Paiement indisponible.', 'error')
      payPanel.querySelectorAll('.ego-pay__btn').forEach((button) => {
        button.disabled = false
      })
      if (trigger) trigger.focus()
    }
  }

  methods.forEach((method) => {
    const button = makeProviderButton(method.provider, method.title, method.hint, startPurchase)
    payPanel.insertBefore(button, payStatus)
  })

  const togglePanel = () => {
    payPanel.hidden = !payPanel.hidden
    if (!payPanel.hidden) {
      setPayStatus('', '')
      const first = payPanel.querySelector('button')
      if (first) first.focus()
    }
  }

  purchaseButtons.forEach((button) => {
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('click', (event) => {
      event.preventDefault()
      togglePanel()
      purchaseButtons.forEach((other) => other.setAttribute('aria-expanded', String(!payPanel.hidden)))
    })
    button.insertAdjacentElement('afterend', payPanel)
  })

  // ------------------------------------------------------------------ tiroir
  const scrim = document.createElement('div')
  scrim.className = 'ego-cart__scrim'
  scrim.hidden = true

  const drawer = document.createElement('aside')
  drawer.className = 'ego-cart'
  drawer.hidden = true
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-modal', 'true')
  drawer.setAttribute('aria-label', 'Panier')

  const head = document.createElement('header')
  head.className = 'ego-cart__head'
  const drawerTitle = document.createElement('h2')
  drawerTitle.textContent = 'Panier'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'ego-cart__close'
  closeButton.setAttribute('aria-label', 'Fermer le panier')
  closeButton.textContent = '✕'
  head.append(drawerTitle, closeButton)

  const list = document.createElement('div')
  list.className = 'ego-cart__list'

  const foot = document.createElement('footer')
  foot.className = 'ego-cart__foot'

  const totalRow = document.createElement('div')
  totalRow.className = 'ego-cart__tot'
  const totalLabel = document.createElement('span')
  totalLabel.textContent = 'Total'
  const totalValue = document.createElement('strong')
  totalValue.className = 'ego-cart__total'
  totalRow.append(totalLabel, totalValue)

  const cartPay = document.createElement('div')
  cartPay.className = 'ego-pay ego-cart__pay'
  const cartPayLabel = document.createElement('span')
  cartPayLabel.className = 'ego-pay__label'
  cartPayLabel.textContent = 'Payer le panier'
  cartPay.appendChild(cartPayLabel)

  const cartStatus = document.createElement('p')
  cartStatus.className = 'ego-pay__status'
  cartStatus.hidden = true
  cartPay.appendChild(cartStatus)

  const cartConfirm = document.createElement('div')
  cartConfirm.className = 'ego-cart__confirm'
  cartConfirm.hidden = true

  const cartPayButtons = []
  const setCartStatus = (text, tone) => {
    cartStatus.textContent = text || ''
    cartStatus.dataset.tone = tone || ''
    cartStatus.hidden = !text
  }

  const startCart = async (provider, trigger) => {
    cartConfirm.hidden = true
    cartPayButtons.forEach((button) => {
      button.disabled = true
    })
    setCartStatus('Redirection…', 'info')
    try {
      const data = await requestCheckout(provider, {
        items: cart.map((item) => ({ slug: item.slug, quantity: item.quantity })),
      })
      if (data.mode === 'paypal_me') {
        cartConfirm.textContent = ''
        cartConfirm.appendChild(paypalMeCard(data))
        cartConfirm.hidden = false
        setCartStatus('', '')
        cartPayButtons.forEach((button) => {
          button.disabled = false
        })
        return
      }
      location.href = data.url
    } catch (error) {
      const key = error instanceof Error ? error.message : ''
      setCartStatus(messages[key] || 'Paiement indisponible.', 'error')
      cartPayButtons.forEach((button) => {
        button.disabled = false
      })
      if (trigger) trigger.focus()
    }
  }

  methods.forEach((method) => {
    const button = makeProviderButton(method.provider, method.title, method.hint, startCart)
    cartPayButtons.push(button)
    cartPay.insertBefore(button, cartStatus)
  })
  foot.append(totalRow, cartPay, cartConfirm)
  drawer.append(head, list, foot)

  const changeQuantity = (itemSlug, delta) => {
    cart = cart
      .map((item) => (item.slug === itemSlug ? { ...item, quantity: item.quantity + delta } : item))
      .filter((item) => item.quantity > 0)
      .map((item) => ({ ...item, quantity: Math.min(item.quantity, MAX_QTY) }))
    save()
    render()
  }

  const removeItem = (itemSlug) => {
    cart = cart.filter((item) => item.slug !== itemSlug)
    save()
    render()
  }

  const addItem = (itemSlug, quantityToAdd) => {
    const existing = cart.find((item) => item.slug === itemSlug)
    if (existing) {
      existing.quantity = Math.min(existing.quantity + quantityToAdd, MAX_QTY)
    } else if (cart.length >= MAX_ITEMS) {
      setCartStatus('Panier plein : 10 produits maximum.', 'error')
      return false
    } else {
      cart.push({ slug: itemSlug, quantity: Math.min(quantityToAdd, MAX_QTY) })
    }
    save()
    render()
    return true
  }

  const cartRow = (item) => {
    const row = document.createElement('article')
    row.className = 'ego-cart__item'
    row.dataset.slug = item.slug

    const info = document.createElement('div')
    info.className = 'ego-cart__info'
    const name = document.createElement('p')
    name.className = 'ego-cart__name'
    name.textContent = nameOf(item.slug)
    const price = document.createElement('p')
    price.className = 'ego-cart__price'
    const unit = priceOf(item.slug)
    price.textContent = unit == null ? '…' : `${euro(unit)} × ${item.quantity}`
    info.append(name, price)

    const stepper = document.createElement('div')
    stepper.className = 'ego-cart__qty'
    const minus = document.createElement('button')
    minus.type = 'button'
    minus.setAttribute('aria-label', `Diminuer la quantité de ${nameOf(item.slug)}`)
    minus.textContent = '−'
    minus.addEventListener('click', () => changeQuantity(item.slug, -1))
    const value = document.createElement('span')
    value.textContent = String(item.quantity)
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.setAttribute('aria-label', `Augmenter la quantité de ${nameOf(item.slug)}`)
    plus.textContent = '+'
    plus.addEventListener('click', () => changeQuantity(item.slug, 1))
    stepper.append(minus, value, plus)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ego-cart__remove'
    remove.textContent = 'Retirer'
    remove.addEventListener('click', () => removeItem(item.slug))

    row.append(info, stepper, remove)
    return row
  }

  const render = () => {
    list.textContent = ''
    if (!cart.length) {
      const empty = document.createElement('p')
      empty.className = 'ego-cart__empty'
      empty.textContent = 'Votre panier est vide. Ajoutez un produit depuis sa fiche.'
      list.appendChild(empty)
    }
    cart.forEach((item) => list.appendChild(cartRow(item)))
    totalValue.textContent = prices ? euro(totalCents()) : '—'

    if (cartButton) {
      const items = count()
      cartButton.setAttribute('aria-label', `Cart, ${items} item${items === 1 ? '' : 's'}`)
      let badge = cartButton.querySelector('.ego-cart__badge')
      if (items > 0) {
        if (!badge) {
          badge = document.createElement('span')
          badge.className = 'ego-cart__badge'
          cartButton.classList.add('ego-cart-trigger')
          cartButton.appendChild(badge)
        }
        badge.textContent = String(items)
      } else if (badge) {
        badge.remove()
      }
    }

    cartPayButtons.forEach((button) => {
      button.disabled = !cart.length
    })
  }

  let lastFocus = null
  const openCart = () => {
    lastFocus = document.activeElement
    scrim.hidden = false
    drawer.hidden = false
    document.body.classList.add('ego-cart-open')
    render()
    closeButton.focus()
  }

  const closeCart = () => {
    scrim.hidden = true
    drawer.hidden = true
    document.body.classList.remove('ego-cart-open')
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus()
  }

  if (addButton) {
    addButton.addEventListener('click', (event) => {
      event.preventDefault()
      if (addItem(slug, 1)) openCart()
    })
  }
  if (cartButton) {
    cartButton.addEventListener('click', (event) => {
      event.preventDefault()
      openCart()
    })
  }
  closeButton.addEventListener('click', closeCart)
  scrim.addEventListener('click', closeCart)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) closeCart()
  })

  document.body.append(scrim, drawer)
  render()

  // Prix serveur : sert uniquement à l'affichage du panier.
  fetch('/api/prices', { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && data.prices) {
        prices = data.prices
        render()
      }
    })
    .catch(() => {})
})()
