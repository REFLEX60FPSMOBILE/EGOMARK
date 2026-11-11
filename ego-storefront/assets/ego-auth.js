// Identification Discord par pseudo. Ce n'est volontairement pas un OAuth :
// le vendeur contacte le client sur le pseudo indiqué pour livrer la commande.
// Le pseudo est mémorisé localement et partagé avec le checkout.
(() => {
  const KEY = 'ego-discord-v1'
  const MAX = 32
  const INVITE = 'https://discord.gg/ZBrNrpXtUw'

  const normalize = (value) => {
    if (typeof value !== 'string') return ''
    const cleaned = value.trim().replace(/^@+/, '').replace(/\s+/g, ' ')
    if (Array.from(cleaned).length < 2 || Array.from(cleaned).length > MAX) return ''
    if (/[<>\u0000-\u001f\u007f]/.test(cleaned)) return ''
    return cleaned
  }

  const read = () => {
    try {
      return normalize(localStorage.getItem(KEY) || '')
    } catch {
      return ''
    }
  }

  let current = read()
  let lastFocus = null

  const emit = () => {
    document.dispatchEvent(new CustomEvent('ego:discord', { detail: { discord: current } }))
  }

  const style = document.createElement('style')
  style.textContent = `
    .ego-discord-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: .42rem;
      height: 38px; max-width: 178px; padding: 0 .78rem; flex: 0 0 auto;
      border: 1px solid rgba(240,232,227,.16); border-radius: 999px;
      background: rgba(24,18,20,.88); color: #f0e8e3; font: inherit;
      font-size: .76rem; font-weight: 600; line-height: 1; cursor: pointer;
      transition: border-color .2s, background .2s, color .2s;
    }
    .ego-discord-btn:hover { border-color: rgba(220,143,148,.62); background: rgba(183,110,114,.14); }
    .ego-discord-btn svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .ego-discord-btn__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ego-discord-btn.is-connected { color: #e7b7b4; border-color: rgba(220,143,148,.36); }
    .ego-join-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: .42rem;
      height: 38px; padding: 0 .78rem; flex: 0 0 auto;
      border: 1px solid rgba(88,101,242,.5); border-radius: 999px;
      background: rgba(88,101,242,.14); color: #dfe1ff; font: inherit;
      font-size: .76rem; font-weight: 600; line-height: 1; text-decoration: none;
      transition: background .2s, border-color .2s, transform .2s;
    }
    .ego-join-btn:hover { background: rgba(88,101,242,.24); border-color: rgba(120,130,255,.9); transform: translateY(-1px); }
    .ego-join-btn svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .ego-join-btn__label { white-space: nowrap; }
    .ego-oauth-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: .42rem;
      height: 38px; padding: 0 .9rem; flex: 0 0 auto;
      border: 1px solid #5865f2; border-radius: 999px;
      background: #5865f2; color: #fff; font: inherit;
      font-size: .76rem; font-weight: 700; line-height: 1; text-decoration: none;
      transition: background .2s, border-color .2s, transform .2s;
    }
    .ego-oauth-btn:hover { background: #4752c4; border-color: #4752c4; color: #fff; transform: translateY(-1px); }
    .ego-oauth-btn svg { width: 16px; height: 16px; flex: 0 0 auto; }
    .ego-oauth-btn__label { white-space: nowrap; }
    .ego-discord-modal[hidden], .ego-discord-modal [hidden] { display: none !important; }
    .ego-discord-modal {
      position: fixed; inset: 0; z-index: 240; display: grid; place-items: center;
      padding: 1rem; color: #f0e8e3; font-family: Inter, system-ui, sans-serif;
    }
    .ego-discord-modal__scrim {
      position: absolute; inset: 0; background: rgba(7,5,6,.76);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    }
    .ego-discord-modal__panel {
      position: relative; width: min(430px, 100%); padding: 1.5rem;
      border: 1px solid rgba(240,232,227,.14); border-radius: 18px;
      background: linear-gradient(145deg, #21191b, #171113);
      box-shadow: 0 30px 80px rgba(0,0,0,.55);
    }
    .ego-discord-modal__close {
      position: absolute; top: .85rem; right: .85rem; width: 2rem; height: 2rem;
      border: 1px solid rgba(240,232,227,.14); border-radius: 999px;
      background: transparent; color: rgba(240,232,227,.7); font: inherit; cursor: pointer;
    }
    .ego-discord-modal__eyebrow {
      display: block; margin: 0 0 .65rem; color: #d9aaa8; font-size: .68rem;
      font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
    }
    .ego-discord-modal h2 { margin: 0 0 .55rem; font-family: "Space Grotesk", Inter, sans-serif; font-size: 1.55rem; line-height: 1.1; }
    .ego-discord-modal__intro { margin: 0; color: rgba(240,232,227,.68); font-size: .86rem; line-height: 1.55; }
    .ego-discord-modal__note { margin: .7rem 0 0; color: rgba(240,232,227,.42); font-size: .72rem; line-height: 1.45; }
    .ego-discord-form { display: grid; gap: .7rem; margin-top: 1.25rem; }
    .ego-discord-form label { display: grid; gap: .35rem; color: rgba(240,232,227,.7); font-size: .75rem; font-weight: 600; }
    .ego-discord-form input {
      width: 100%; height: 46px; padding: 0 .8rem; border: 1px solid rgba(240,232,227,.16);
      border-radius: 10px; outline: none; background: rgba(10,7,8,.55); color: #f0e8e3;
      font: inherit; font-size: .9rem; transition: border-color .2s, box-shadow .2s;
    }
    .ego-discord-form input:focus { border-color: rgba(220,143,148,.65); box-shadow: 0 0 0 3px rgba(183,110,114,.12); }
    .ego-discord-form__error { margin: 0; color: #e6b0ad; font-size: .76rem; }
    .ego-discord-form__submit {
      height: 44px; border: 1px solid rgba(240,232,227,.12); border-radius: 999px;
      background: #b76e72; color: #1a1112; font: inherit; font-size: .82rem;
      font-weight: 700; cursor: pointer;
    }
    .ego-discord-form__submit:hover { background: #cf8589; }
    .ego-discord-modal__logout {
      margin-top: .8rem; padding: 0; border: 0; background: none; color: rgba(240,232,227,.55);
      font: inherit; font-size: .74rem; text-decoration: underline; cursor: pointer;
    }
    body.ego-discord-open { overflow: hidden; }
    @media (max-width: 1180px) {
      .ego-join-btn, .ego-oauth-btn { width: 38px; padding: 0; }
      .ego-join-btn__label, .ego-oauth-btn__label { display: none; }
    }
    @media (max-width: 720px) {
      .ego-discord-btn { padding: 0 .65rem; max-width: 46px; }
      .ego-discord-btn__label { display: none; }
      .ego-join-btn { width: 38px; padding: 0; }
      .ego-join-btn__label { display: none; }
      .ego-discord-modal__panel { padding: 1.25rem; }
    }
  `
  document.head.appendChild(style)

  const modal = document.createElement('div')
  modal.className = 'ego-discord-modal'
  modal.hidden = true
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-labelledby', 'ego-discord-title')
  modal.innerHTML = `
    <div class="ego-discord-modal__scrim" data-ego-discord-close></div>
    <div class="ego-discord-modal__panel">
      <button type="button" class="ego-discord-modal__close" aria-label="Fermer" data-ego-discord-close>✕</button>
      <span class="ego-discord-modal__eyebrow">Identification</span>
      <h2 id="ego-discord-title">Pseudo de livraison</h2>
      <p class="ego-discord-modal__intro">Entre le pseudo Discord sur lequel tu veux recevoir ta commande. Aucun mot de passe ne t’est demandé.</p>
      <p class="ego-discord-modal__note">C’est une identification simple, pas une connexion officielle à Discord. Le vendeur te contacte sur ce pseudo pour vérifier le paiement et livrer.</p>
      <form class="ego-discord-form" novalidate>
        <label>Pseudo Discord
          <input name="discord" maxlength="32" autocomplete="username" placeholder="ex. ego.market" required />
        </label>
        <p class="ego-discord-form__error" hidden></p>
        <button type="submit" class="ego-discord-form__submit">Continuer avec ce pseudo</button>
      </form>
      <button type="button" class="ego-discord-modal__logout" hidden>Se déconnecter</button>
    </div>
  `

  const form = modal.querySelector('form')
  const input = modal.querySelector('input[name="discord"]')
  const error = modal.querySelector('.ego-discord-form__error')
  const logout = modal.querySelector('.ego-discord-modal__logout')
  const close = () => {
    modal.hidden = true
    document.body.classList.remove('ego-discord-open')
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus()
  }
  const open = () => {
    lastFocus = document.activeElement
    input.value = current
    error.hidden = true
    logout.hidden = !current
    modal.hidden = false
    document.body.classList.add('ego-discord-open')
    window.requestAnimationFrame(() => input.focus())
  }

  const save = (value) => {
    current = normalize(value)
    try {
      if (current) localStorage.setItem(KEY, current)
      else localStorage.removeItem(KEY)
    } catch {
      /* stockage indisponible : la session reste en mémoire */
    }
    updateButton()
    emit()
  }

  modal.querySelectorAll('[data-ego-discord-close]').forEach((element) => element.addEventListener('click', close))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = normalize(input.value)
    if (!value) {
      error.textContent = 'Pseudo invalide : 2 à 32 caractères, sans chevrons.'
      error.hidden = false
      input.focus()
      return
    }
    save(value)
    close()
  })
  logout.addEventListener('click', () => {
    save('')
    close()
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    current = read()
    updateButton()
    emit()
  })

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ego-discord-btn'
  button.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8.5 8.5c2.2-1.1 4.8-1.1 7 0"></path>
      <path d="M7 16.5c3.2 1.4 6.8 1.4 10 0"></path>
      <path d="M8.2 17.5 7 19.5c-1.8-.4-3.2-1.2-4.2-2.4.4-4.7 2.4-8.3 5.4-10.9l1.1 1.7"></path>
      <path d="m15.8 17.5 1.2 2c1.8-.4 3.2-1.2 4.2-2.4-.4-4.7-2.4-8.3-5.4-10.9l-1.1 1.7"></path>
      <circle cx="9.2" cy="12.7" r=".8" fill="currentColor" stroke="none"></circle>
      <circle cx="14.8" cy="12.7" r=".8" fill="currentColor" stroke="none"></circle>
    </svg>
    <span class="ego-discord-btn__label">Connexion</span>
  `
  button.addEventListener('click', open)

  const updateButton = () => {
    const label = button.querySelector('.ego-discord-btn__label')
    label.textContent = current ? `@${current}` : 'Pseudo'
    button.classList.toggle('is-connected', Boolean(current))
    button.setAttribute('aria-label', current ? `Pseudo de livraison @${current}. Modifier.` : 'Indiquer le pseudo Discord de livraison')
    button.title = current ? `Pseudo de livraison @${current}` : 'Pseudo Discord pour la livraison'
  }

  const oauth = document.createElement('a')
  oauth.className = 'ego-oauth-btn'
  oauth.href = '/auth/discord'
  oauth.setAttribute('aria-label', 'Se connecter avec Discord')
  oauth.title = 'Se connecter avec Discord'
  oauth.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>
    <span class="ego-oauth-btn__label">Se connecter</span>
  `

  const join = document.createElement('a')
  join.className = 'ego-join-btn'
  join.href = INVITE
  join.target = '_blank'
  join.rel = 'noopener noreferrer'
  join.setAttribute('aria-label', 'Rejoindre le serveur Discord EGO Market')
  join.title = 'Rejoindre le serveur Discord'
  join.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 7.5A15 15 0 0 1 12 6a15 15 0 0 1 5 1.5c1.4 2.1 2.1 4.7 2 7.5-1.2.9-2.6 1.4-4 1.5l-.8-1.1c.5-.2 1-.5 1.4-.8-2.8 1.3-5.4 1.3-8.2 0 .4.3.9.6 1.4.8L8 16.5c-1.4-.1-2.8-.6-4-1.5-.1-2.8.6-5.4 2-7.5Z"></path>
      <path d="M9.5 12.2h.01M14.5 12.2h.01"></path>
    </svg>
    <span class="ego-join-btn__label">Discord</span>
  `

  const mount = () => {
    document.body.appendChild(modal)
    const host =
      document.querySelector('.header-actions') ||
      document.querySelector('.lx-header__actions')
    if (host) {
      const burger = host.querySelector('.menu-toggle, .lx-burger')
      if (burger) {
        host.insertBefore(oauth, burger)
        host.insertBefore(join, burger)
        host.insertBefore(button, burger)
      } else {
        host.append(oauth, join, button)
      }
    }
    updateButton()
  }

  window.EGOAuth = { get: () => current, set: save, open, close, normalize, key: KEY }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()

// Notification des erreurs de connexion Discord OAuth2. Le callback du Worker
// redirige vers l'accueil avec un code court ; aucun secret ne transite par l'URL.
(() => {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('discord_error') || params.get('auth_error')
  if (!code) return
  const messages = {
    access_denied: 'Connexion Discord annulée.',
    not_configured: 'La connexion Discord n’est pas encore configurée.',
    state_mismatch: 'La connexion a expiré. Réessaie.',
    token_exchange_failed: 'Discord n’a pas pu valider la connexion.',
    user_fetch_failed: 'Impossible de récupérer ton profil Discord.',
    discord_already_linked: 'Ce compte Discord est déjà lié à un autre compte.',
    discord_unavailable: 'Discord est momentanément indisponible.',
    oauth_failed: 'La connexion Discord a échoué. Réessaie.',
  }
  const mount = () => {
    const toast = document.createElement('div')
    toast.setAttribute('role', 'alert')
    toast.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:300;display:flex;align-items:center;gap:12px;max-width:min(440px,calc(100% - 24px));padding:12px 14px;border:1px solid rgba(255,107,122,.4);border-radius:12px;background:#2a1518;color:#ffc2c8;box-shadow:0 18px 50px rgba(0,0,0,.4);font:500 13px/1.45 Inter,system-ui,sans-serif;'
    const text = document.createElement('span')
    text.textContent = messages[code] || messages.oauth_failed
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '✕'
    close.setAttribute('aria-label', 'Fermer la notification')
    close.style.cssText = 'border:0;background:transparent;color:inherit;font:inherit;font-size:17px;line-height:1;cursor:pointer;padding:0 0 0 4px;'
    const remove = () => {
      toast.remove()
      const url = new URL(window.location.href)
      url.searchParams.delete('discord_error')
      url.searchParams.delete('auth_error')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
    close.addEventListener('click', remove)
    toast.append(text, close)
    document.body.appendChild(toast)
    window.setTimeout(remove, 12000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
