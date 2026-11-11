// Panier + commande PayPal manuelle : ajout depuis la fiche produit, tiroir
// persistant (localStorage), quantités, suppression et total. Le client paie
// sur PayPal.Me, puis renseigne son pseudo Discord et l'ID de transaction.
// Les montants sont toujours recalculés côté serveur, jamais depuis le panier.
(() => {
  const match = location.pathname.match(/^\/product\/([a-z0-9-]+)\/?$/)
  if (!match) return

  const slug = match[1]
  const CART_KEY = 'ego-cart-v1'
  const DISCORD_KEY = 'ego-discord-v1'
  const MAX_ITEMS = 10
  const MAX_QTY = 10
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
  const PAYPAL_REF_RE = /^[A-Za-z0-9-]{6,64}$/
  const DISCORD_INVITE = 'https://discord.gg/ZBrNrpXtUw'
  const DISCORD_JOINED_KEY = 'ego-discord-joined-v1'
  const euro = (cents) => `${(cents / 100).toFixed(2)} €`

  const messages = {
    manual_orders_unavailable: 'Les commandes ne sont pas encore activées. Réessaie plus tard.',
    invalid_body: 'La demande est incomplète. Réessaie.',
    invalid_discord: 'Pseudo Discord invalide.',
    invalid_paypal_ref: 'ID de transaction PayPal invalide.',
    paypal_ref_exists: 'Cet ID de transaction a déjà été utilisé.',
    manual_order_failed: 'La commande n’a pas pu être enregistrée. Réessaie.',
    unknown_product: 'Produit introuvable.',
    invalid_product: 'Produit introuvable.',
    invalid_cart: 'Le panier est invalide. Videz-le et réessaie.',
    cart_too_large: 'Le panier est limité à 10 produits.',
    checkout_failed: 'Le paiement n’a pas pu démarrer. Réessaie.',
    promo_invalid: 'Ce code promo n’est pas valide.',
    promo_expired: 'Ce code promo a expiré.',
    promo_exhausted: 'Ce code promo a atteint sa limite d’utilisation.',
    promo_minimum: 'Ce panier ne remplit pas le minimum requis pour ce code.',
    promo_unavailable: 'Les codes promo sont indisponibles pour le moment.',
  }

  const readDiscord = () => {
    try {
      return (localStorage.getItem(DISCORD_KEY) || '').trim().replace(/^@+/, '')
    } catch {
      return ''
    }
  }
  const currentDiscord = () => {
    try {
      if (window.EGOAuth && typeof window.EGOAuth.get === 'function') {
        const value = window.EGOAuth.get()
        if (value) return value
      }
    } catch {
      /* le repli local reste disponible */
    }
    return readDiscord()
  }

  // Rejoindre le Discord est obligatoire avant de payer : la livraison et le
  // support passent par le serveur. On ne peut pas vérifier l'adhésion côté
  // navigateur, donc le client confirme explicitement l'avoir rejoint.
  let discordJoined = false
  try {
    discordJoined = localStorage.getItem(DISCORD_JOINED_KEY) === '1'
  } catch {
    /* stockage indisponible : la confirmation restera en mémoire */
  }
  const hasJoinedDiscord = () => discordJoined
  const markDiscordJoined = () => {
    discordJoined = true
    try {
      localStorage.setItem(DISCORD_JOINED_KEY, '1')
    } catch {
      /* stockage indisponible : la confirmation reste valable pour la session */
    }
  }

  const gateStyle = document.createElement('style')
  gateStyle.textContent = `
    .ego-join-gate[hidden], .ego-join-gate [hidden] { display: none !important; }
    .ego-join-gate {
      position: fixed; inset: 0; z-index: 260; display: grid; place-items: center;
      padding: 1rem; color: #f0e8e3; font-family: Inter, system-ui, sans-serif;
    }
    .ego-join-gate__scrim {
      position: absolute; inset: 0; background: rgba(7,5,6,.78);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    }
    .ego-join-gate__panel {
      position: relative; width: min(460px, 100%); padding: 1.6rem;
      border: 1px solid rgba(88,101,242,.35); border-radius: 20px;
      background: linear-gradient(145deg, #1d1926, #141116);
      box-shadow: 0 30px 80px rgba(0,0,0,.6);
    }
    .ego-join-gate__close {
      position: absolute; top: .85rem; right: .85rem; width: 2rem; height: 2rem;
      border: 1px solid rgba(240,232,227,.14); border-radius: 999px;
      background: transparent; color: rgba(240,232,227,.7); font: inherit; cursor: pointer;
    }
    .ego-join-gate__eyebrow {
      display: block; margin: 0 0 .65rem; color: #b9c0ff; font-size: .68rem;
      font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
    }
    .ego-join-gate h2 {
      margin: 0 0 .6rem; font-family: "Space Grotesk", Inter, sans-serif;
      font-size: 1.65rem; line-height: 1.1;
    }
    .ego-join-gate__copy { margin: 0; color: rgba(240,232,227,.72); font-size: .88rem; line-height: 1.6; }
    .ego-join-gate__invite {
      display: flex; align-items: center; justify-content: center; gap: .5rem;
      min-height: 46px; margin-top: 1.1rem; padding: .65rem 1rem; border-radius: 999px;
      background: #5865f2; color: #fff; font-size: .82rem; font-weight: 700;
      text-decoration: none; transition: background .2s;
    }
    .ego-join-gate__invite:hover { background: #6d78f5; }
    .ego-join-gate__check {
      display: flex; align-items: flex-start; gap: .6rem; margin-top: 1rem;
      color: rgba(240,232,227,.8); font-size: .82rem; line-height: 1.45; cursor: pointer;
    }
    .ego-join-gate__check input { width: 18px; height: 18px; margin: .1rem 0 0; accent-color: #5865f2; }
    .ego-join-gate__hint { margin: .7rem 0 0; color: rgba(240,232,227,.45); font-size: .72rem; line-height: 1.5; }
    .ego-join-gate__continue {
      width: 100%; min-height: 44px; margin-top: 1.1rem; border: 0; border-radius: 999px;
      background: #b76e72; color: #1a1112; font: inherit; font-size: .84rem; font-weight: 700; cursor: pointer;
    }
    .ego-join-gate__continue:disabled { opacity: .4; cursor: not-allowed; }
    .ego-join-gate__cancel {
      display: block; width: 100%; margin-top: .55rem; padding: .35rem; border: 0;
      background: none; color: rgba(240,232,227,.5); font: inherit; font-size: .75rem;
      text-decoration: underline; cursor: pointer;
    }
    body.ego-join-gate-open { overflow: hidden; }
    .ego-pay__discord { margin: .7rem 0 0; color: rgba(240,232,227,.55); font-size: .72rem; line-height: 1.5; }
    .ego-pay__discord a { color: #b9c0ff; text-decoration: underline; text-underline-offset: 2px; }
    .ego-delivery {
      margin-top: 1rem; padding: 1rem; border: 1px solid rgba(88,101,242,.3);
      border-radius: 12px; background: rgba(88,101,242,.07);
    }
    .ego-delivery__title { margin: 0 0 .55rem; font-family: "Space Grotesk", Inter, sans-serif; font-size: .95rem; font-weight: 600; }
    .ego-delivery ol { margin: 0 0 .85rem; padding-left: 1.1rem; color: rgba(240,232,227,.72); font-size: .78rem; line-height: 1.6; }
    .ego-delivery__btn {
      display: flex; align-items: center; justify-content: center; gap: .45rem;
      min-height: 40px; padding: .55rem .9rem; border-radius: 999px;
      background: #5865f2; color: #fff; font-size: .78rem; font-weight: 700;
      text-decoration: none; transition: background .2s;
    }
    .ego-delivery__btn:hover { background: #6d78f5; }
    @media (max-width: 640px) { .ego-join-gate__panel { padding: 1.25rem; } }
  `
  document.head.appendChild(gateStyle)

  const gate = document.createElement('div')
  gate.className = 'ego-join-gate'
  gate.hidden = true
  gate.setAttribute('role', 'dialog')
  gate.setAttribute('aria-modal', 'true')
  gate.setAttribute('aria-labelledby', 'ego-join-gate-title')
  gate.innerHTML = `
    <div class="ego-join-gate__scrim" data-ego-join-close></div>
    <div class="ego-join-gate__panel" role="document">
      <button type="button" class="ego-join-gate__close" aria-label="Fermer" data-ego-join-close>✕</button>
      <span class="ego-join-gate__eyebrow">Avant de commander</span>
      <h2 id="ego-join-gate-title">Rejoins le Discord</h2>
      <p class="ego-join-gate__copy">La livraison et le support passent par notre serveur Discord. Rejoins-le avant de passer commande.</p>
      <a class="ego-join-gate__invite" href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Rejoindre le serveur Discord <span aria-hidden="true">→</span></a>
      <label class="ego-join-gate__check"><input type="checkbox" /> <span>J’ai rejoint le serveur Discord</span></label>
      <p class="ego-join-gate__hint">Après ton paiement, ouvre un ticket dans <strong>#support-achat</strong> avec ton ID de transaction PayPal.</p>
      <button type="button" class="ego-join-gate__continue" disabled>Continuer vers le paiement</button>
      <button type="button" class="ego-join-gate__cancel" data-ego-join-close>Pas maintenant</button>
    </div>
  `
  document.body.appendChild(gate)

  const gateCheck = gate.querySelector('input[type="checkbox"]')
  const gateContinue = gate.querySelector('.ego-join-gate__continue')
  let gateResolve = null
  let gatePromise = null
  let gateFocus = null

  gateCheck.addEventListener('change', () => {
    gateContinue.disabled = !gateCheck.checked
  })
  const closeGate = (accepted) => {
    if (!gateResolve) return
    const resolve = gateResolve
    gateResolve = null
    gatePromise = null
    gate.hidden = true
    document.body.classList.remove('ego-join-gate-open')
    if (gateFocus && typeof gateFocus.focus === 'function') gateFocus.focus()
    resolve(accepted)
  }
  gate.querySelectorAll('[data-ego-join-close]').forEach((element) =>
    element.addEventListener('click', () => closeGate(false)),
  )
  gateContinue.addEventListener('click', () => {
    if (!gateCheck.checked) return
    markDiscordJoined()
    closeGate(true)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !gate.hidden) closeGate(false)
  })

  const ensureDiscordJoin = () => {
    if (hasJoinedDiscord()) return Promise.resolve(true)
    if (gatePromise) return gatePromise
    gateFocus = document.activeElement
    gateCheck.checked = false
    gateContinue.disabled = true
    gate.hidden = false
    document.body.classList.add('ego-join-gate-open')
    gatePromise = new Promise((resolve) => {
      gateResolve = resolve
    })
    window.requestAnimationFrame(() => gate.querySelector('.ego-join-gate__invite')?.focus())
    return gatePromise
  }

  // ------------------------------------------------------------------ panier
  let prices = null
  let packOffers = null
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

  const postJson = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }

  const requestPayPalLink = (items, promoCode) =>
    postJson('/api/orders/manual/link', promoCode ? { items, promoCode } : { items })

  // Jeton de suivi remis à la création : permet à /dashboard/ d'afficher les
  // commandes de ce navigateur sans compte ni mot de passe.
  const ORDERS_KEY = 'ego-orders-v1'
  const rememberOrder = (order) => {
    if (!order || typeof order.orderId !== 'string' || typeof order.clientToken !== 'string') return
    let entries = []
    try {
      const raw = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]')
      entries = Array.isArray(raw) ? raw : []
    } catch {
      entries = []
    }
    entries = entries.filter((entry) => entry && entry.orderId !== order.orderId)
    entries.unshift({ orderId: order.orderId, token: order.clientToken })
    try {
      localStorage.setItem(ORDERS_KEY, JSON.stringify(entries.slice(0, 50)))
    } catch {
      /* stockage indisponible : le suivi restera dans cet onglet */
    }
  }

  const requireDiscord = (setStatus) => {
    if (currentDiscord()) return true
    setStatus('Entre ton pseudo Discord pour continuer.', 'info')
    if (window.EGOAuth && typeof window.EGOAuth.open === 'function') window.EGOAuth.open()
    return false
  }

  // Carte de commande : lien PayPal.Me, mode d'emploi, pseudo Discord et
  // formulaire de confirmation avec l'ID de transaction.
  const manualCard = (data, items, onSuccess) => {
    const card = document.createElement('div')
    card.className = 'ego-pay__confirm'
    let currentData = data
    let currentPromo = data.promo?.code || ''

    const lead = document.createElement('p')
    lead.className = 'ego-pay__note'
    const leadStrong = document.createElement('strong')
    leadStrong.textContent = 'Paiement PayPal uniquement.'
    lead.append(leadStrong, document.createTextNode(' Envoie le montant exact, puis confirme ci-dessous.'))

    const amount = document.createElement('p')
    amount.className = 'ego-pay__note'
    const summary = document.createElement('p')
    summary.className = 'ego-pay__note ego-pay__summary'
    summary.hidden = true

    const go = document.createElement('a')
    go.className = 'ego-pay__go'
    go.target = '_blank'
    go.rel = 'noopener noreferrer'

    const updateAmount = () => {
      const total = currentData.totalCents
      amount.textContent = `Montant à payer : ${euro(total)}.`
      go.href = currentData.url
      go.textContent = `Payer ${euro(total)} avec PayPal`
      if (currentData.discountCents > 0) {
        summary.textContent = `Sous-total ${euro(currentData.subtotalCents)} · remise ${euro(currentData.discountCents)} · total ${euro(total)}.`
        summary.hidden = false
      } else {
        summary.hidden = true
      }
    }
    updateAmount()

    const promo = document.createElement('div')
    promo.className = 'ego-promo'
    const promoLabel = document.createElement('label')
    promoLabel.className = 'ego-promo__label'
    promoLabel.textContent = 'Code promo'
    const promoRow = document.createElement('div')
    promoRow.className = 'ego-promo__row'
    const promoInput = document.createElement('input')
    promoInput.type = 'text'
    promoInput.name = 'promoCode'
    promoInput.maxLength = 32
    promoInput.autocomplete = 'off'
    promoInput.spellcheck = false
    promoInput.placeholder = 'Ex. EGO10'
    promoInput.setAttribute('aria-label', 'Code promo')
    const promoButton = document.createElement('button')
    promoButton.type = 'button'
    promoButton.className = 'ego-promo__btn'
    promoButton.textContent = 'Appliquer'
    promoRow.append(promoInput, promoButton)
    const promoHint = document.createElement('span')
    promoHint.className = 'ego-promo__hint'
    promoHint.textContent = 'EGO10 · 10 % de remise'
    const promoStatus = document.createElement('p')
    promoStatus.className = 'ego-promo__status'
    promoStatus.setAttribute('role', 'status')
    promoStatus.hidden = true
    promo.append(promoLabel, promoRow, promoHint, promoStatus)

    const setPromoStatus = (text, tone) => {
      promoStatus.textContent = text || ''
      promoStatus.dataset.tone = tone || ''
      promoStatus.hidden = !text
    }

    const applyPromo = async () => {
      const code = promoInput.value.trim().toUpperCase()
      promoButton.disabled = true
      setPromoStatus(code ? 'Vérification du code…' : 'Retrait du code…', 'info')
      try {
        const updated = await requestPayPalLink(items, code)
        currentData = updated
        currentPromo = updated.promo?.code || ''
        promoInput.value = currentPromo
        updateAmount()
        setPromoStatus(
          currentPromo && updated.discountCents > 0
            ? `Code ${currentPromo} appliqué : ${euro(updated.discountCents)} de remise.`
            : 'Aucun code appliqué.',
          currentPromo ? 'success' : '',
        )
      } catch (error) {
        const key = error instanceof Error ? error.message : ''
        promoInput.value = currentPromo
        setPromoStatus(messages[key] || 'Ce code promo n’a pas pu être appliqué.', 'error')
      } finally {
        promoButton.disabled = false
      }
    }
    promoButton.addEventListener('click', applyPromo)
    promoInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        applyPromo()
      }
    })

    const steps = document.createElement('ol')
    steps.className = 'ego-pay__steps'
    ;[
      'Ouvre PayPal et envoie le montant exact au compte affiché.',
      'Reviens ici et colle l’ID de transaction de ton reçu PayPal.',
      'On vérifie le paiement, puis on te livre sur Discord.',
    ].forEach((text) => {
      const li = document.createElement('li')
      li.textContent = text
      steps.appendChild(li)
    })

    const who = document.createElement('p')
    who.className = 'ego-pay__who'
    const whoText = document.createElement('span')
    const whoName = document.createElement('strong')
    const change = document.createElement('button')
    change.type = 'button'
    change.className = 'ego-pay__linkbtn'
    change.textContent = 'Changer'
    change.addEventListener('click', () => window.EGOAuth?.open?.())
    who.append(whoText, whoName, change)
    const updateWho = () => {
      const value = currentDiscord()
      whoText.textContent = 'Livraison Discord : '
      whoName.textContent = value ? `@${value}` : 'non connecté'
      change.hidden = !value
    }
    updateWho()
    document.addEventListener('ego:discord', updateWho)

    const discordNote = document.createElement('p')
    discordNote.className = 'ego-pay__discord'
    const discordLink = document.createElement('a')
    discordLink.href = DISCORD_INVITE
    discordLink.target = '_blank'
    discordLink.rel = 'noopener noreferrer'
    discordLink.textContent = 'Rejoindre le serveur Discord'
    discordNote.append(document.createTextNode('Commande réservée aux membres Discord. '), discordLink)

    const form = document.createElement('form')
    form.className = 'ego-pay__form'
    form.noValidate = true

    const refField = document.createElement('label')
    refField.className = 'ego-pay__field'
    refField.textContent = 'ID de transaction PayPal'
    const refInput = document.createElement('input')
    refInput.name = 'paypalRef'
    refInput.type = 'text'
    refInput.required = true
    refInput.maxLength = 64
    refInput.autocomplete = 'off'
    refInput.placeholder = 'Ex. 7AB12345CD678901E'
    refField.appendChild(refInput)

    const noteField = document.createElement('label')
    noteField.className = 'ego-pay__field'
    noteField.textContent = 'Note (optionnel)'
    const noteInput = document.createElement('textarea')
    noteInput.name = 'note'
    noteInput.maxLength = 500
    noteInput.rows = 2
    noteInput.placeholder = 'Une précision pour ta commande…'
    noteField.appendChild(noteInput)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'ego-pay__submit'
    submit.textContent = 'J’ai payé — envoyer ma commande'

    const formStatus = document.createElement('p')
    formStatus.className = 'ego-pay__status'
    formStatus.setAttribute('role', 'status')
    formStatus.hidden = true
    const setFormStatus = (text, tone) => {
      formStatus.textContent = text || ''
      formStatus.dataset.tone = tone || ''
      formStatus.hidden = !text
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!(await ensureDiscordJoin())) return
      const discord = currentDiscord()
      if (!discord) {
        setFormStatus('Entre ton pseudo Discord pour continuer.', 'error')
        window.EGOAuth?.open?.()
        return
      }
      const paypalRef = refInput.value.trim().toUpperCase()
      if (!PAYPAL_REF_RE.test(paypalRef)) {
        setFormStatus('Colle l’ID de transaction présent sur ton reçu PayPal.', 'error')
        refInput.focus()
        return
      }

      submit.disabled = true
      setFormStatus('Enregistrement de la commande…', 'info')
      try {
        const result = await postJson('/api/orders/manual', {
          items: items.map((item) => ({ slug: item.slug, quantity: item.quantity })),
          discord,
          paypalRef,
          note: noteInput.value.trim(),
          promoCode: currentPromo || undefined,
        })
        const success = document.createElement('div')
        success.className = 'ego-pay__success'
        const successTitle = document.createElement('h3')
        successTitle.textContent = 'Commande enregistrée'
        const successRef = document.createElement('p')
        successRef.className = 'ego-pay__ref'
        successRef.textContent = result.order?.orderId || 'Référence en cours'
        const successText = document.createElement('p')
        successText.className = 'ego-pay__note'
        successText.textContent = `Merci pour votre confiance ! Votre commande a bien été enregistrée. La livraison de vos articles s’effectue directement sur notre serveur Discord, après vérification du paiement.`
        const delivery = document.createElement('div')
        delivery.className = 'ego-delivery'
        const deliveryTitle = document.createElement('p')
        deliveryTitle.className = 'ego-delivery__title'
        deliveryTitle.textContent = 'Comment récupérer votre produit ?'
        const deliverySteps = document.createElement('ol')
        ;[
          'Rejoignez notre serveur officiel avec le bouton ci-dessous.',
          'Ouvrez un ticket dans #support-achat ou contactez un vendeur.',
          'Munissez-vous de votre ID de transaction PayPal pour une remise instantanée.',
        ].forEach((text) => {
          const li = document.createElement('li')
          li.textContent = text
          deliverySteps.appendChild(li)
        })
        const deliveryLink = document.createElement('a')
        deliveryLink.className = 'ego-delivery__btn'
        deliveryLink.href = DISCORD_INVITE
        deliveryLink.target = '_blank'
        deliveryLink.rel = 'noopener noreferrer'
        deliveryLink.textContent = 'Rejoindre le serveur Discord'
        delivery.append(deliveryTitle, deliverySteps, deliveryLink)
        rememberOrder(result.order)
        const dashboardLink = document.createElement('a')
        dashboardLink.href = '/dashboard/'
        dashboardLink.className = 'ego-pay__linkbtn'
        dashboardLink.textContent = 'Suivre mes commandes →'
        success.append(successTitle, successRef, successText, delivery, dashboardLink)
        card.replaceChildren(success)
        onSuccess?.(result)
      } catch (error) {
        const key = error instanceof Error ? error.message : ''
        setFormStatus(messages[key] || 'La commande n’a pas pu être enregistrée. Réessaie.', 'error')
        submit.disabled = false
      }
    })

    form.append(refField, noteField, submit, formStatus)
    card.append(lead, amount, summary, promo, go, steps, who, discordNote, form)
    return card
  }

  // --------------------------------------------------------- paiement direct
  const payPanel = document.createElement('div')
  payPanel.className = 'ego-pay'
  payPanel.hidden = true

  const payLabel = document.createElement('span')
  payLabel.className = 'ego-pay__label'
  payLabel.textContent = 'Paiement PayPal'
  payPanel.appendChild(payLabel)

  const payNotice = document.createElement('p')
  payNotice.className = 'ego-pay__note'
  payNotice.textContent = 'Paiement manuel · livraison sur Discord'
  payPanel.appendChild(payNotice)

  const payStatus = document.createElement('p')
  payStatus.className = 'ego-pay__status'
  payStatus.setAttribute('role', 'status')
  payStatus.hidden = true
  payPanel.appendChild(payStatus)

  const setPayStatus = (text, tone) => {
    payStatus.textContent = text || ''
    payStatus.dataset.tone = tone || ''
    payStatus.hidden = !text
  }

  const payButton = document.createElement('button')
  payButton.type = 'button'
  payButton.className = 'ego-pay__btn'
  payButton.dataset.provider = 'paypal'
  const payButtonMain = document.createElement('span')
  payButtonMain.textContent = 'Payer avec PayPal'
  const payButtonHint = document.createElement('span')
  payButtonHint.className = 'ego-pay__hint'
  payButtonHint.textContent = 'Envoi manuel · livraison Discord'
  payButton.append(payButtonMain, payButtonHint)
  payPanel.insertBefore(payButton, payStatus)

  const payDiscord = document.createElement('p')
  payDiscord.className = 'ego-pay__discord'
  const payDiscordLink = document.createElement('a')
  payDiscordLink.href = DISCORD_INVITE
  payDiscordLink.target = '_blank'
  payDiscordLink.rel = 'noopener noreferrer'
  payDiscordLink.textContent = 'Rejoindre le serveur Discord'
  payDiscord.append(document.createTextNode('Commande réservée aux membres Discord. '), payDiscordLink)
  payPanel.insertBefore(payDiscord, payButton)

  const startPurchase = async () => {
    if (!(await ensureDiscordJoin())) return
    if (!requireDiscord(setPayStatus)) return
    payButton.disabled = true
    setPayStatus('Préparation du paiement PayPal…', 'info')
    try {
      const items = [{ slug, quantity: quantity() }]
      const data = await requestPayPalLink(items)
      const previous = payPanel.querySelector('.ego-pay__confirm')
      if (previous) previous.remove()
      payPanel.appendChild(
        manualCard(data, items, () => {
          setPayStatus('Commande envoyée. On te livre sur Discord après vérification.', 'success')
        }),
      )
      setPayStatus('', '')
    } catch (error) {
      const key = error instanceof Error ? error.message : ''
      setPayStatus(messages[key] || 'Paiement indisponible.', 'error')
    } finally {
      payButton.disabled = false
    }
  }
  payButton.addEventListener('click', startPurchase)

  const togglePanel = () => {
    payPanel.hidden = !payPanel.hidden
    if (!payPanel.hidden) {
      setPayStatus('', '')
      payButton.focus()
    }
  }

  purchaseButtons.forEach((button) => {
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      if (payPanel.hidden && !(await ensureDiscordJoin())) return
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
  cartPayLabel.textContent = 'Paiement PayPal'
  cartPay.appendChild(cartPayLabel)

  const cartNotice = document.createElement('p')
  cartNotice.className = 'ego-pay__note'
  cartNotice.textContent = 'PayPal uniquement · livraison manuelle sur Discord'
  cartPay.appendChild(cartNotice)

  const cartStatus = document.createElement('p')
  cartStatus.className = 'ego-pay__status'
  cartStatus.setAttribute('role', 'status')
  cartStatus.hidden = true
  cartPay.appendChild(cartStatus)

  const cartConfirm = document.createElement('div')
  cartConfirm.className = 'ego-cart__confirm'
  cartConfirm.hidden = true

  const cartPayButton = document.createElement('button')
  cartPayButton.type = 'button'
  cartPayButton.className = 'ego-pay__btn'
  cartPayButton.dataset.provider = 'paypal'
  const cartPayButtonMain = document.createElement('span')
  cartPayButtonMain.textContent = 'Payer le panier avec PayPal'
  const cartPayButtonHint = document.createElement('span')
  cartPayButtonHint.className = 'ego-pay__hint'
  cartPayButtonHint.textContent = 'Envoi manuel · livraison Discord'
  cartPayButton.append(cartPayButtonMain, cartPayButtonHint)
  cartPay.appendChild(cartPayButton)

  const cartDiscord = document.createElement('p')
  cartDiscord.className = 'ego-pay__discord'
  const cartDiscordLink = document.createElement('a')
  cartDiscordLink.href = DISCORD_INVITE
  cartDiscordLink.target = '_blank'
  cartDiscordLink.rel = 'noopener noreferrer'
  cartDiscordLink.textContent = 'Rejoindre le serveur Discord'
  cartDiscord.append(document.createTextNode('Commande réservée aux membres Discord. '), cartDiscordLink)
  cartPay.insertBefore(cartDiscord, cartPayButton)

  const setCartStatus = (text, tone) => {
    cartStatus.textContent = text || ''
    cartStatus.dataset.tone = tone || ''
    cartStatus.hidden = !text
  }

  const startCart = async () => {
    cartConfirm.hidden = true
    cartConfirm.textContent = ''
    if (!(await ensureDiscordJoin())) return
    if (!requireDiscord(setCartStatus)) return
    cartPayButton.disabled = true
    setCartStatus('Préparation du paiement PayPal…', 'info')
    try {
      const items = cart.map((item) => ({ slug: item.slug, quantity: item.quantity }))
      const data = await requestPayPalLink(items)
      cartConfirm.appendChild(
        manualCard(data, items, () => {
          cart = []
          save()
          render()
          setCartStatus('Commande envoyée. On te livre sur Discord après vérification.', 'success')
        }),
      )
      cartConfirm.hidden = false
      setCartStatus('', '')
    } catch (error) {
      const key = error instanceof Error ? error.message : ''
      setCartStatus(messages[key] || 'Paiement indisponible.', 'error')
      cartPayButton.disabled = false
    }
  }
  cartPayButton.addEventListener('click', startCart)

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

  // Offre pack : uniquement sur le produit pilote Nitro. Le prix et la remise
  // viennent de l'API, jamais d'un montant saisi dans la page.
  const renderPack = () => {
    if (slug !== 'nitro-boost-gift-link' || !packOffers || !packOffers[slug]) return
    if (document.querySelector('.ego-pack')) return
    const offer = packOffers[slug]
    if (!offer || !offer.slug || !Number.isFinite(offer.amountCents)) return

    const section = document.createElement('section')
    section.className = 'ego-pack'
    section.setAttribute('aria-label', 'Pack Nitro Boost Gift Link x3')

    const head = document.createElement('div')
    head.className = 'ego-pack__head'
    const eyebrow = document.createElement('span')
    eyebrow.className = 'ego-pack__eyebrow'
    eyebrow.textContent = 'Pack pilote'
    const badge = document.createElement('span')
    badge.className = 'ego-pack__badge'
    badge.textContent = `−${offer.discountPercent} %`
    head.append(eyebrow, badge)

    const title = document.createElement('h3')
    title.textContent = `${offer.quantity} × Nitro Boost Gift Link`

    const copy = document.createElement('p')
    copy.className = 'ego-pack__copy'
    copy.textContent = 'Trois liens cadeaux avec 10 % de remise, calculée sur le prix unitaire.'

    const priceRow = document.createElement('div')
    priceRow.className = 'ego-pack__price'
    const price = document.createElement('strong')
    price.textContent = euro(offer.amountCents)
    const unit = document.createElement('span')
    unit.textContent = `${euro(offer.unitCents)} l’unité · économise ${euro(offer.savingsCents)}`
    priceRow.append(price, unit)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ego-pack__btn'
    button.textContent = `Ajouter le pack — ${euro(offer.amountCents)}`
    button.addEventListener('click', () => {
      if (addItem(offer.slug, 1)) openCart()
    })

    const note = document.createElement('p')
    note.className = 'ego-pack__note'
    note.textContent = 'Paiement PayPal · livraison Discord'

    section.append(head, title, copy, priceRow, button, note)
    payPanel.insertAdjacentElement('beforebegin', section)
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

    cartPayButton.disabled = !cart.length
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

  const dashboardButton = [...document.querySelectorAll('button')].find((button) =>
    /^\s*dashboard\s*$/i.test((button.textContent || '').trim()),
  )
  if (dashboardButton) {
    dashboardButton.addEventListener('click', (event) => {
      event.preventDefault()
      window.location.href = '/dashboard/'
    })
  }

  document.body.append(scrim, drawer)
  render()

  // Prix serveur : sert uniquement à l'affichage du panier.
  fetch('/api/prices', { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && data.prices) {
        prices = data.prices
        packOffers = data.packs || null
        render()
        renderPack()
      }
    })
    .catch(() => {})
})()
