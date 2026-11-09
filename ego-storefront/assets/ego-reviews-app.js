// Page Avis : charge uniquement les avis réellement publiés par l'API.
// Aucun avis, aucune note et aucun compteur n'est inventé côté navigateur.
(() => {
  const $ = (id) => document.getElementById(id)

  const listEl = $('reviews-list')
  const emptyEl = $('reviews-empty')
  const formEl = $('review-form')
  const statusEl = $('reviews-status')
  const scoreEl = $('reviews-score')
  const avgEl = $('reviews-average')
  const countEl = $('reviews-count')
  const starsEl = $('reviews-stars')
  const openBtn = $('reviews-open-form')
  const cancelBtn = $('reviews-cancel')

  if (!listEl || !emptyEl || !formEl) return

  const MESSAGES = {
    order_unknown: 'Commande introuvable. Vérifiez le numéro et l’e-mail utilisés au paiement.',
    already_reviewed: 'Un avis a déjà été publié pour cette commande.',
    invalid_order: 'Le numéro de commande est invalide.',
    invalid_email: 'L’adresse e-mail est invalide.',
    invalid_author: 'Indiquez un nom de 2 à 40 caractères.',
    invalid_rating: 'Choisissez une note de 1 à 5 étoiles.',
    invalid_body: 'Votre avis doit contenir entre 20 et 1 200 caractères, sans lien.',
    rate_limited: 'Trop de tentatives. Réessayez dans une heure.',
    reviews_unavailable: 'Le service d’avis n’est pas encore activé sur cette version du site.',
  }

  const setStatus = (message, tone) => {
    if (!statusEl) return
    statusEl.textContent = message || ''
    statusEl.dataset.tone = tone || ''
    statusEl.hidden = !message
  }

  const starRow = (rating) => {
    const row = document.createElement('span')
    row.className = 'stars'
    row.setAttribute('aria-label', `${rating} sur 5`)
    for (let i = 1; i <= 5; i += 1) {
      const star = document.createElement('span')
      star.className = i <= rating ? 'star is-on' : 'star'
      star.textContent = '★'
      star.setAttribute('aria-hidden', 'true')
      row.appendChild(star)
    }
    return row
  }

  const formatDate = (iso) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  }

  const renderReview = (review) => {
    const article = document.createElement('article')
    article.className = 'review-card'

    const head = document.createElement('div')
    head.className = 'review-card__head'

    const identity = document.createElement('div')
    const author = document.createElement('strong')
    author.textContent = review.author
    const meta = document.createElement('span')
    meta.className = 'review-card__meta'
    meta.textContent = [review.productName || review.productSlug, formatDate(review.createdAt)]
      .filter(Boolean)
      .join(' · ')
    identity.append(author, meta)

    const badge = document.createElement('span')
    badge.className = 'review-badge'
    badge.textContent = 'Achat vérifié'

    head.append(identity, badge)

    const rating = document.createElement('div')
    rating.className = 'review-card__rating'
    rating.appendChild(starRow(Number(review.rating) || 0))

    const body = document.createElement('p')
    body.className = 'review-card__body'
    body.textContent = review.body

    article.append(head, rating, body)
    return article
  }

  const renderSummary = (summary) => {
    if (!scoreEl) return
    const count = Number(summary && summary.count ? summary.count : 0)
    if (!count || summary.average == null) {
      scoreEl.hidden = true
      return
    }
    if (avgEl) avgEl.textContent = Number(summary.average).toFixed(1).replace('.', ',')
    if (countEl) countEl.textContent = count === 1 ? '1 avis vérifié' : `${count} avis vérifiés`
    if (starsEl) {
      starsEl.textContent = ''
      starsEl.appendChild(starRow(Math.round(Number(summary.average))))
    }
    scoreEl.hidden = false
  }

  const load = async () => {
    try {
      const response = await fetch('/api/reviews?limit=24', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const reviews = Array.isArray(data.reviews) ? data.reviews : []

      renderSummary(data.summary)

      if (!reviews.length) {
        listEl.textContent = ''
        listEl.hidden = true
        emptyEl.hidden = false
        return
      }

      listEl.textContent = ''
      reviews.forEach((review) => listEl.appendChild(renderReview(review)))
      listEl.hidden = false
      emptyEl.hidden = true
    } catch {
      // Service indisponible : on conserve l'état vide honnête, sans inventer.
      setStatus(
        'Les avis ne peuvent pas être chargés pour le moment. Aucun avis inventé ne sera affiché à la place.',
        'warn',
      )
    }
  }

  const openForm = () => {
    formEl.hidden = false
    setStatus('', '')
    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const first = $('rv-order')
    if (first) first.focus({ preventScroll: true })
  }

  openBtn && openBtn.addEventListener('click', openForm)

  cancelBtn &&
    cancelBtn.addEventListener('click', () => {
      formEl.hidden = true
      formEl.reset()
      setStatus('', '')
    })

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submitBtn = formEl.querySelector('button[type="submit"]')
    const checked = formEl.querySelector('input[name="rating"]:checked')

    if (!checked) {
      setStatus('Choisissez une note de 1 à 5 étoiles.', 'error')
      return
    }

    const payload = {
      orderId: ($('rv-order') && $('rv-order').value.trim()) || '',
      email: ($('rv-email') && $('rv-email').value.trim()) || '',
      author: ($('rv-author') && $('rv-author').value.trim()) || '',
      rating: Number(checked.value),
      body: ($('rv-body') && $('rv-body').value.trim()) || '',
    }

    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = 'Envoi…'
    }
    setStatus('', '')

    try {
      const response = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setStatus(MESSAGES[data.error] || 'L’avis n’a pas pu être publié. Réessayez.', 'error')
        return
      }

      formEl.reset()
      formEl.hidden = true
      setStatus('Merci. Votre avis vérifié est publié.', 'success')
      await load()
    } catch {
      setStatus('Envoi impossible. Vérifiez votre connexion puis réessayez.', 'error')
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Publier mon avis'
      }
    }
  })

  load()
})()
