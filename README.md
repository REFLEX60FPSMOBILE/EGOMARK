# SaaS landing page

A dark, animated marketing page for a software product: hero with a live
product mock, logo cloud, feature bento, how it works, a tabbed showcase,
metrics, testimonials, pricing with a billing toggle, FAQ, email capture and
footer. Every section is its own component and all copy lives in one file.

## Run it

```sh
bun install
bun run dev        # http://localhost:5173 (Vite + the Worker in workerd)
bun run build      # dist/client (assets) + dist/saas_landing/index.js (Worker)
```

## Edit it

- `src/content.ts` holds every string, price and link. Start there.
- `src/sections/*` are the page sections. `src/App.tsx` stacks them; delete or
  reorder lines there to remove or move a section.
- `src/styles.css` holds the design tokens (colours, radii, fonts, keyframes).
  Everything rounded is a squircle via `corner-shape`; true circles use `.round`.
  Bordered surfaces use the `depth` utility instead of a border: an inset edge
  plus a top highlight, the same treatment as the Freebuff desktop app. The
  element must be positioned; recolour the edge with `--depth-edge`.
- `src/worker/index.ts` is the Cloudflare Worker. `/api/subscribe` receives the
  email form; connect it to your provider or a D1 table.

## Commande PayPal manuelle + pseudo Discord

La boutique ne propose plus de paiement par carte. Le parcours actuel est
volontairement manuel :

1. Le client choisit ses produits et clique sur **Payer avec PayPal**.
2. Le site ouvre `https://www.paypal.me/<PAYPAL_ME_HANDLE>` avec le montant
   total prérempli, calculé côté serveur depuis `src/worker/prices.ts`.
3. Après paiement, le client colle l’ID de transaction PayPal et confirme avec
   son pseudo Discord (mémorisé localement, sans mot de passe).
4. La commande est enregistrée dans `manual_orders` avec le statut `pending`.
5. Le vendeur vérifie le paiement dans PayPal, livre le produit sur Discord,
   puis passe la commande à `delivered`.

Le pseudo Discord est une **identification simple**, pas un OAuth Discord : il
permet de savoir où livrer et de contacter le client, mais ne prouve pas son
identité. La vérification du paiement PayPal reste obligatoire avant livraison.

```sh
# Lister les commandes en attente (ADMIN_TOKEN dans l'en-tête)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<domaine>/api/admin/manual-orders

# Marquer une commande comme livrée
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"status":"delivered"}' \
  https://<domaine>/api/admin/manual-orders/<order_id>/status
```

### Tableau de bord admin

La page `/admin/` permet de saisir `ADMIN_TOKEN` dans le navigateur, puis de
suivre les 100 dernières commandes manuelles : client Discord, articles, total,
remise, code promo et statut. Une commande en attente peut être marquée livrée
ou annulée, puis rouverte ; les codes promo et leur consommation sont affichés
en lecture seule. Les données se rafraîchissent toutes les 60 secondes.

Le jeton reste uniquement dans le `sessionStorage` de l’onglet et n’est jamais
ajouté à l’URL ni au dépôt. La page est en `noindex` et n’est pas liée depuis la
boutique.

`POST /api/orders/manual/link` renvoie le lien PayPal.Me et le total recalculé.
`POST /api/orders/manual` accepte `{ items, discord, paypalRef, note?, promoCode? }` et
refuse un pseudo invalide, une transaction déjà utilisée ou un panier inconnu.
Le pseudo est stocké sous la clé locale `ego-discord-v1` ; le panier reste sous
`ego-cart-v1`.

### Prix, pack et codes promo

Les prix de `src/worker/prices.ts` sont la seule source de vérité : le montant
affiché peut être amélioré, mais le lien PayPal et la commande sont toujours
recalculés côté serveur. Le catalogue a une baisse permanente (aucun faux prix
barré) et le pack **Nitro Boost Gift Link ×3** applique une remise réelle de
10 % sur trois unités. `GET /api/prices` renvoie aussi `packs` pour l’affichage.

Le code de lancement **`EGO10`** offre 10 % sur le total après remise pack,
jusqu’à 1 000 commandes. Il est stocké en D1 (`promo_codes`) et chaque commande
consomme une utilisation dans `promo_redemptions`. Un code invalide, expiré ou
épuisé est refusé côté serveur ; le navigateur ne peut pas imposer le montant.

```sh
# Créer ou remplacer un code (ADMIN_TOKEN requis)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"code":"EGO10","percentOff":10,"maxUses":1000}' \
  https://<domaine>/api/admin/promo-codes

# Lister les codes et leur consommation
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<domaine>/api/admin/promo-codes
```

`POST /api/orders/manual/link` et `POST /api/orders/manual` acceptent donc
`promoCode`. Le lien de paiement affiche le sous-total, la remise et le total
net ; le code est revérifié au moment d’enregistrer la commande.

## Avis clients vérifiés après achat

La page `/reviews/index.html` n'affiche que des avis réellement déposés après
une commande payée. Aucune donnée n'est inventée : tant qu'aucun avis n'existe,
la page garde son état vide.

- `migrations/0001_reviews.sql` : tables `orders` (source de vérité) et `reviews`.
- `migrations/0002_payments.sql` : `payment_ref` (unique) et `source` sur `orders`,
  pour tracer un achat Stripe.
- `POST /api/reviews` : dépôt public. Vérifie le numéro de commande **et**
  l'e-mail utilisé au paiement, refuse les doublons (une commande = un avis),
  les liens et les textes hors bornes.
- `GET /api/reviews?product=&limit=` : lecture publique ; moyenne et compteur
  calculés en SQL sur les seuls avis publiés.
- `POST /api/checkout` : crée une session **Stripe Checkout hébergée** pour un
  produit et renvoie son URL. Le prix vient de `src/worker/prices.ts` (généré
  depuis le catalogue), jamais du navigateur.
- `POST /api/payments/webhook` : **porte d'entrée automatique**. Stripe notifie
  après un encaissement réussi ; la commande est enregistrée et ouvre aussitôt
  le droit à un avis vérifié. Signature `stripe-signature` obligatoire.
- `POST /api/admin/orders` : enregistrement manuel de secours (commande payée
  hors flux), protégé par `ADMIN_TOKEN`.
- `POST /api/admin/reviews/:id/hide|restore` : modération.

Développement local (Worker + D1 local, port 4176) :

```sh
bun run db:local   # applique toutes les migrations sur la base D1 locale
bun run dev:store  # sert le storefront + l'API
```

## Paiement Stripe

Les boutons « Purchase » des fiches produit appellent `POST /api/checkout`, qui
crée une session Checkout côté serveur et redirige vers la page Stripe. Stripe
rappelle ensuite `/api/payments/webhook` ; c'est ce rappel, et lui seul, qui
crée la commande ouvrant le droit à un avis.

Variables nécessaires :

| Variable | Rôle |
| --- | --- |
| `STRIPE_SECRET_KEY` | clé secrète (`sk_test_…` / `sk_live_…`) pour créer les sessions |
| `STRIPE_WEBHOOK_SECRET` | secret de signature (`whsec_…`) du endpoint webhook |
| `SITE_ORIGIN` | origine publique pour `success_url` / `cancel_url` (facultatif, sinon l'origine de la requête) |

```sh
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Dans le tableau de bord Stripe, le endpoint à déclarer est
`https://<domaine>/api/payments/webhook`, avec l'événement
`checkout.session.completed`. En local :

```sh
stripe listen --forward-to http://127.0.0.1:4176/api/payments/webhook
```

Vérification de la signature : HMAC-SHA256 du corps brut préfixé par
`<t>.`, comparé en temps constant à chaque `v1` de l'en-tête
`stripe-signature: t=<ts>,v1=<sig>` ; au-delà de 5 minutes d'écart, la requête
est refusée (anti-rejeu).

Comportement : `201` à la première réception (`reviewEligible: true`), `200`
`{"duplicated":true}` sur un rejeu identique, `409` si le même numéro de
commande ou le même `payment_intent` arrive avec des données différentes, `401`
si la signature est absente, fausse ou trop ancienne, `400` si la session n'est
pas payée (`payment_status` différent de `paid`), `503` si
`STRIPE_WEBHOOK_SECRET` ou `STRIPE_SECRET_KEY` n'est pas configuré.

À définir avant toute mise en ligne : les secrets `ADMIN_TOKEN`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et `REVIEW_SALT`
(`wrangler secret put …`), et une base D1 liée sur le binding `DB`. Sans ce
binding, l'API répond `reviews_unavailable` et la page reste sur son état vide
— jamais sur des avis inventés.

### PayPal

Le bouton Purchase propose aussi PayPal (Orders v2, `intent: CAPTURE`), en
plus de la carte Stripe.

- `POST /api/checkout` avec `{"provider":"paypal"}` crée la commande PayPal et
  renvoie l'URL d'approbation ; les montants viennent toujours de
  `src/worker/prices.ts`.
- Au retour, `GET /api/payments/paypal/return?token=<id PayPal>` capture le
  paiement côté serveur, enregistre la commande (`source = 'paypal'`,
  `payment_ref = <id de capture>`) puis redirige vers `/reviews/?order=…`.
- `POST /api/payments/paypal` reçoit les webhooks PayPal et vérifie la signature
  via `/v1/notifications/verify-webhook-signature` (`PAYPAL_WEBHOOK_ID`
  obligatoire). L'événement `PAYMENT.CAPTURE.COMPLETED` sert de filet de
  sécurité quand le client ne revient pas sur le site.

Variables : `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` et
`PAYPAL_ENV` (`live` en production, sandbox par défaut). Endpoint webhook à
déclarer dans le tableau de bord PayPal : `https://<domaine>/api/payments/paypal`,
avec `PAYMENT.CAPTURE.COMPLETED`.

#### Activer le paiement PayPal automatique

1. Sur <https://developer.paypal.com/dashboard/applications>, ouvrir
   l'application REST du compte **EGOMarket265** en mode *Live* (ou en créer
   une : *Create App*).
2. Copier **Client ID** et **Secret**.
3. Dans cette application, ajouter un webhook vers
   `https://<domaine>/api/payments/paypal` avec l'événement
   `PAYMENT.CAPTURE.COMPLETED`, puis copier son **Webhook ID**.
4. Renseigner ces valeurs **hors du dépôt** : en local dans `.dev.vars`
   (copier `.dev.vars.example`, jamais commité), en production dans les
   secrets de l'hébergeur. Ne jamais les écrire dans un fichier suivi par git.

Tant que `PAYPAL_CLIENT_ID` et `PAYPAL_CLIENT_SECRET` sont absents, le bouton
PayPal reste sur PayPal.Me. Dès qu'ils sont présents, le flux Orders v2 prend
le relais : capture côté serveur, commande enregistrée et droit à l'avis
vérifié, sans aucune intervention manuelle.

### Paiement direct PayPal.Me

Sans identifiants API (`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`), le bouton
PayPal envoie l'acheteur sur `https://www.paypal.me/EGOMarket265` avec le
montant exact prérempli (`…/0.85EUR`). Le montant est calculé côté serveur
depuis `src/worker/prices.ts` (jamais par le navigateur) et la référence
`EGO-…` s'affiche pour que l'acheteur la recopie dans la note PayPal.

Ce mode n'ouvre **pas** le droit à un avis automatiquement : PayPal.Me ne
signe aucun webhook côté serveur. Pour accorder l'avis, enregistrer la
commande payée via `POST /api/admin/orders` (en-tête `Authorization: Bearer
<ADMIN_TOKEN>`) avec la même référence, l'e-mail PayPal et le slug du produit ;
l'acheteur peut alors déposer son avis vérifié. Pour retrouver l'automatisme,
renseigner les identifiants API du compte : le flux Orders v2 reprend la main.

Handle modifiable via `PAYPAL_ME_HANDLE` (défaut `EGOMarket265`).

### Panier

Les fiches produit ont un vrai panier, stocké dans `localStorage` sous
`ego-cart-v1` : ajout depuis la fiche, compteur sur le bouton d'en-tête, tiroir
latéral avec quantités, suppression et total, puis paiement.

- `GET /api/prices` expose le barème pour l'affichage ; le montant facturé est
  toujours recalculé depuis `src/worker/prices.ts`.
- `POST /api/checkout` accepte `{ items: [{ slug, quantity }], provider }`
  (10 produits maximum, 10 unités par produit, doublons fusionnés). Le panier
  vide, un slug inconnu ou un panier trop grand sont refusés (`400`/`404`).
- Carte : une seule session Stripe avec un article par ligne ; le webhook crée
  une commande par article (`EGO-…-1`, `EGO-…-2`, …), donc un droit à l'avis
  par produit.
- PayPal.Me : le lien porte le total du panier, une seule référence.
  PayPal Orders v2 (si les identifiants API sont configurés) ne gère qu'un
  produit par paiement : un panier de plusieurs produits répond `409
  paypal_cart_unsupported`.

L'achat direct depuis la fiche (`Purchase`) reste disponible et ne dépend pas
du panier.

## Mise en production du storefront

Checklist avant d'ouvrir les paiements réels. Toutes les valeurs sensibles se
définissent dans les secrets de l'hébergeur, jamais dans un fichier suivi par
git.

### Secrets
- `REVIEW_SALT` : valeur aléatoire longue, **définie une fois et jamais
  changée** — les empreintes d'e-mail des commandes et des avis en dépendent.
- `ADMIN_TOKEN` : jeton long pour `/api/admin/*`, dont `/api/admin/init`
  (initialisation D1) et `/api/admin/orders` (enregistrement manuel d'un
  paiement PayPal.Me).
- `STRIPE_SECRET_KEY` : clé Live `sk_live_…`.
- `STRIPE_WEBHOOK_SECRET` : secret `whsec_…` du endpoint Live.
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` : application REST **Live**.
- `PAYPAL_WEBHOOK_ID` : webhook **Live** ; sans lui, `POST
  /api/payments/paypal` répond `503`.

### Variables simples
- `PAYPAL_ENV=live` : valeur exacte, sensible à la casse ; sinon l'API sandbox
  est utilisée.
- `SITE_ORIGIN=https://<domaine>` : origine publique exacte, sans slash final.
  Elle construit les retours PayPal et les URL de succès/annulation Stripe.
- `PAYPAL_ME_HANDLE=EGOMarket265` : facultatif (même valeur par défaut).

### Base et assets
- D1 sur le binding `DB`. Après le premier déploiement, appeler une fois
  `POST /api/admin/init` avec `ADMIN_TOKEN` pour créer les tables ; l'endpoint
  est idempotent. Les migrations `0001_reviews.sql` puis `0002_payments.sql`
  restent la référence pour une base existante.
- Assets statiques préparés dans `dist/storefront-assets` par
  `npm run build:store` ; `ego-storefront/` reste la source locale.

### Webhooks à créer
- PayPal : `https://<domaine>/api/payments/paypal`, événement
  `PAYMENT.CAPTURE.COMPLETED`.
- Stripe : `https://<domaine>/api/payments/webhook`, événements
  `checkout.session.completed` et `checkout.session.async_payment_succeeded`.

### Pièges
- Ne pas déployer le sel de développement `local-dev-salt-change-me` de
  `wrangler.storefront.jsonc` : le secret `REVIEW_SALT` doit le remplacer.
- Une rotation de `REVIEW_SALT` casse la vérification des commandes déjà
  passées.
- Sans `STRIPE_WEBHOOK_SECRET`, le webhook Stripe répond `503` et aucune
  commande carte n'est enregistrée.
- Sans clés PayPal, repli PayPal.Me : pas d'avis automatique, il faut
  `ADMIN_TOKEN`.
- Les webhooks exigent HTTPS : PayPal et Stripe ne peuvent pas joindre
  `127.0.0.1`.

## Déploiement

La landing (`deploy.json`, `bun run build`) publie `dist/client` et
`dist/saas_landing/index.js`, séparément du storefront.

Le storefront se prépare avec `npm run build:store` (Python 3 + Pillow requis).
Avant toute génération, `npm run check:catalog` vérifie que les marques retirées
(listées dans `scripts/catalog-policy.json`) ne réapparaissent pas et qu'un même
produit n'a pas de carte, d'entrée ou de prix serveur en double, ni de prix
contradictoire entre le JSON, la carte et `src/worker/prices.ts`. Les prix
identiques entre deux produits différents restent normaux et autorisés. Si le
contrôle échoue, le build s'arrête avant Wrangler.

Le même build lance `npm run check:descriptions` : dans les meta `description`,
`og:description`, `twitter:description` et chaque bloc `section.lxv__desc` des
fiches, il refuse les puces résiduelles (`·`, `•`, `▪`, `◦`, `●`), les
séparateurs décoratifs (`━`, `---`, `___`, `===`) et les `<li>` vides ou réduits
à un séparateur. Une description vide ou une meta absente bloque aussi le
build. Le contrôle repasse sur `dist/storefront-assets` après la copie des
assets, donc sur ce qui part réellement en ligne ; `--path` permet de viser une
fiche isolée.

- bundle du Worker dans `dist/storefront/index.js` ;
- assets utiles copiés dans `dist/storefront-assets` : toutes les pages HTML et
  les seuls fichiers réellement référencés. `assets/remote` (76 Mo, inutilisé)
  et les images orphelines sont exclus ; les images produits sont ré-encodées
  en WebP 800 px pour passer sous la limite de 10 MiB.

Le manifeste `deploy.storefront.json` pointe sur ces deux sorties : c'est lui
qu'il faut passer à `sites_deploy`, pas `deploy.json`.

### Déploiement et smoke test

Le storefront est publié via Sites (`deploy.storefront.json`). Chaque
déploiement se termine par une commande unique qui vérifie que la nouvelle
version est en ligne, puis enchaîne le smoke test :

```sh
npm run deploy:store
# Attente plus courte, sans reconstruire :
python scripts/deploy_storefront.py --no-build --timeout 60
```

Le build publie `dist/storefront-assets/build.json`, une empreinte des HTML,
CSS, JS et du bundle Worker. `deploy:store` reconstruit les assets, attend que
cette empreinte soit servie en production (300 s par défaut), vérifie les
descriptions des fiches publiques, puis exécute `scripts/smoke_prod.py`. Un
déploiement périmé, une description non nettoyée ou un smoke test oublié font
donc échouer la commande.

Le contrôle des descriptions publiques peut être relancé seul :

```sh
npm run check:descriptions:prod
# Une fiche précise :
python scripts/check_public_descriptions.py --slug 3-month-nitro-2-boosts-phone-verified
```

Le smoke test seul reste disponible :

```sh
npm run smoke:prod
# Autre environnement :
python scripts/smoke_prod.py --base-url http://127.0.0.1:4176
```

Le test vérifie `/api/prices`, la fiche produit et
`POST /api/orders/manual/link` : prix `2,49 €`, panier à deux articles avec
quantités et total recalculés serveur, application du code `EGO10` (remise,
total et lien `paypal.me`) et refus d’un code inconnu. `--promo-code` cible un
autre code actif. Aucune commande n’est créée et aucun usage de promo n’est
consommé. Il sort avec le code `1` si l’un de ces contrôles échoue.
