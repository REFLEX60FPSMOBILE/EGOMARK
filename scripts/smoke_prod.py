#!/usr/bin/env python3
"""Smoke test post-déploiement du storefront EGO Market.

Vérifie, en lecture seule :
- le prix public du pack « 3 Month Nitro + 2 Boosts + Phone Verified » ;
- la fiche produit ;
- un panier à plusieurs articles (quantités et totaux recalculés côté serveur) ;
- l'application d'un code promo (remise, total et lien PayPal) ;
- le refus d'un code promo inconnu ;
- le lien PayPal renvoyé par /api/orders/manual/link et son montant.

Aucune commande n'est créée et aucun code promo n'est consommé : les endpoints
manuels ne réservent l'usage qu'à la création d'une commande.
"""

import argparse
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

SLUG = "3-month-nitro-2-boosts-phone-verified"
EXPECTED_CENTS = 249
EXPECTED_LABEL = "2.49 €"
# Panier de contrôle : deux exemplaires du pack Nitro + un lien cadeau.
CART = (
    (SLUG, 2),
    ("nitro-boost-gift-link", 1),
)
DEFAULT_PROMO_CODE = "EGO10"
INVALID_PROMO_CODE = "SMOKEINVALID"
DEFAULT_BASE_URL = "https://egomarket.freebuff.page"
DEFAULT_HANDLE = "EGOMarket265"
PAYPAL_HOSTS = {"paypal.me", "www.paypal.me"}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


class SmokeError(RuntimeError):
    pass


def request_text(base_url, path, *, data=None, method=None, timeout=20):
    headers = {
        "User-Agent": "EGO-smoke-test/1.0",
        "Cache-Control": "no-cache",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(
        base_url + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:300]
        raise SmokeError(f"{path} : HTTP {error.code} {detail}") from error
    except URLError as error:
        raise SmokeError(f"{path} : {error.reason}") from error


def get_json(base_url, path):
    _, body = request_text(base_url, path)
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise SmokeError(f"{path} : réponse JSON invalide") from error


def post_json(base_url, path, payload):
    _, body = request_text(
        base_url,
        path,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
    )
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise SmokeError(f"{path} : réponse JSON invalide") from error


def post_json_status(base_url, path, payload):
    """POST tolérant aux erreurs HTTP : renvoie (statut, corps JSON ou texte)."""
    request = Request(
        base_url + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "User-Agent": "EGO-smoke-test/1.0",
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = response.status
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        status = error.code
    except URLError as error:
        raise SmokeError(f"{path} : {error.reason}") from error

    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, body


def amount_label(cents):
    return f"{cents / 100:.2f} €"


def expected_paypal_path(handle, cents):
    return f"/{handle}/{cents / 100:.2f}EUR"


def check_paypal_link(link, handle, cents, context):
    if not isinstance(link, str):
        raise SmokeError(f"{context} : lien PayPal absent de la réponse")
    parsed = urlparse(link)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in PAYPAL_HOSTS
        or parsed.path.rstrip("/") != expected_paypal_path(handle, cents)
    ):
        raise SmokeError(f"{context} : lien PayPal inattendu {link!r}")
    return link


def cart_expectation(prices):
    """Éléments et sous-total attendus, calculés depuis /api/prices."""
    items = []
    total = 0
    for slug, quantity in CART:
        entry = prices.get(slug)
        if not isinstance(entry, dict):
            raise SmokeError(f"prix absent de /api/prices pour {slug}")
        cents = entry.get("amountCents")
        if not isinstance(cents, int) or cents <= 0:
            raise SmokeError(f"prix invalide dans /api/prices pour {slug} : {cents!r}")
        items.append({"slug": slug, "quantity": quantity, "amountCents": cents})
        total += cents * quantity
    return items, total


def check_cart_items(payment, expected_items, context):
    returned = payment.get("items")
    if not isinstance(returned, list) or len(returned) != len(expected_items):
        raise SmokeError(f"{context} : articles renvoyés incohérents")
    for got, want in zip(returned, expected_items):
        if not isinstance(got, dict):
            raise SmokeError(f"{context} : article mal formé")
        for field in ("slug", "quantity", "amountCents"):
            if got.get(field) != want[field]:
                raise SmokeError(
                    f"{context} : {field} incohérent pour {want['slug']} "
                    f"({got.get(field)!r} au lieu de {want[field]!r})"
                )


def check_payment(payment, *, subtotal, discount, context, handle, promo_code=None):
    total = subtotal - discount
    if payment.get("provider") != "paypal_manual":
        raise SmokeError(f"{context} : provider PayPal manuel inattendu")
    if payment.get("subtotalCents") != subtotal:
        raise SmokeError(
            f"{context} : sous-total {payment.get('subtotalCents')!r} "
            f"au lieu de {subtotal}"
        )
    if payment.get("discountCents") != discount:
        raise SmokeError(
            f"{context} : remise {payment.get('discountCents')!r} "
            f"au lieu de {discount}"
        )
    if payment.get("totalCents") != total or payment.get("amountCents") != total:
        raise SmokeError(
            f"{context} : total {payment.get('totalCents')!r} / "
            f"{payment.get('amountCents')!r} au lieu de {total}"
        )
    if payment.get("amountLabel") != amount_label(total):
        raise SmokeError(
            f"{context} : libellé {payment.get('amountLabel')!r} "
            f"au lieu de {amount_label(total)!r}"
        )

    promo = payment.get("promo")
    if promo_code is None:
        if promo is not None:
            raise SmokeError(f"{context} : code promo appliqué sans demande")
    else:
        if not isinstance(promo, dict) or promo.get("code") != promo_code:
            raise SmokeError(f"{context} : code promo non appliqué ({promo!r})")
        if not isinstance(promo.get("label"), str) or not promo["label"].strip():
            raise SmokeError(f"{context} : libellé de remise absent")

    return check_paypal_link(payment.get("url"), handle, total, context)


def run_once(base_url, handle, promo_code, cache_bust):
    prices_payload = get_json(base_url, f"/api/prices?smoke={cache_bust}")
    prices = prices_payload.get("prices") or {}

    price_entry = prices.get(SLUG)
    if not isinstance(price_entry, dict):
        raise SmokeError(f"prix Nitro absent de /api/prices ({SLUG})")
    if price_entry.get("amountCents") != EXPECTED_CENTS:
        raise SmokeError(
            f"prix Nitro inattendu : {price_entry.get('amountCents')!r} "
            f"au lieu de {EXPECTED_CENTS}"
        )

    _, product_page = request_text(
        base_url,
        f"/product/{SLUG}/index.html?smoke={cache_bust}",
    )
    if "2.49" not in product_page:
        raise SmokeError("prix 2.49 absent de la fiche produit publique")

    # 1. Panier simple : un article.
    single = post_json(
        base_url,
        f"/api/orders/manual/link?smoke={cache_bust}",
        {"items": [{"slug": SLUG, "quantity": 1}]},
    )
    if single.get("totalCents") != EXPECTED_CENTS or single.get("amountCents") != EXPECTED_CENTS:
        raise SmokeError(
            f"montant PayPal inattendu : {single.get('totalCents')!r} / "
            f"{single.get('amountCents')!r} au lieu de {EXPECTED_CENTS}"
        )
    if single.get("amountLabel") != EXPECTED_LABEL:
        raise SmokeError(f"libellé PayPal inattendu : {single.get('amountLabel')!r}")
    single_link = check_paypal_link(single.get("url"), handle, EXPECTED_CENTS, "panier simple")

    # 2. Panier à plusieurs articles : quantités et total recalculés serveur.
    expected_items, subtotal = cart_expectation(prices)
    cart_payload = [{"slug": slug, "quantity": quantity} for slug, quantity in CART]
    multi = post_json(
        base_url,
        f"/api/orders/manual/link?smoke={cache_bust}",
        {"items": cart_payload},
    )
    check_cart_items(multi, expected_items, "panier multi-articles")
    check_payment(
        multi,
        subtotal=subtotal,
        discount=0,
        context="panier multi-articles",
        handle=handle,
    )

    # 3. Code promo sur ce panier : remise cohérente, total et lien recalculés.
    promo_payment = post_json(
        base_url,
        f"/api/orders/manual/link?smoke={cache_bust}",
        {"items": cart_payload, "promoCode": promo_code},
    )
    check_cart_items(promo_payment, expected_items, f"promo {promo_code}")
    discount = promo_payment.get("discountCents")
    if not isinstance(discount, int) or discount <= 0:
        raise SmokeError(f"promo {promo_code} : aucune remise appliquée")
    if discount >= subtotal:
        raise SmokeError(f"promo {promo_code} : remise {discount} >= sous-total {subtotal}")
    if promo_payment.get("subtotalCents") != subtotal:
        raise SmokeError(
            f"promo {promo_code} : sous-total {promo_payment.get('subtotalCents')!r} "
            f"modifié par la remise"
        )
    check_payment(
        promo_payment,
        subtotal=subtotal,
        discount=discount,
        context=f"promo {promo_code}",
        handle=handle,
        promo_code=promo_code,
    )

    # 4. Code inconnu : refus explicite, sans effet de bord.
    invalid_status, invalid_body = post_json_status(
        base_url,
        f"/api/orders/manual/link?smoke={cache_bust}",
        {"items": cart_payload, "promoCode": INVALID_PROMO_CODE},
    )
    if invalid_status != 400 or not isinstance(invalid_body, dict) or invalid_body.get("error") != "promo_invalid":
        raise SmokeError(
            f"code promo inconnu : réponse {invalid_status} {invalid_body!r} "
            "au lieu de 400 promo_invalid"
        )

    return {
        "price": price_entry,
        "single_link": single_link,
        "multi": multi,
        "promo": promo_payment,
        "invalid": (invalid_status, invalid_body.get("error")),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SMOKE_BASE_URL", DEFAULT_BASE_URL),
        help="URL du storefront (défaut : production EGO Market)",
    )
    parser.add_argument(
        "--handle",
        default=os.environ.get("SMOKE_PAYPAL_HANDLE", DEFAULT_HANDLE),
        help="nom PayPal.Me attendu",
    )
    parser.add_argument(
        "--promo-code",
        default=os.environ.get("SMOKE_PROMO_CODE", DEFAULT_PROMO_CODE),
        help=f"code promo actif attendu (défaut : {DEFAULT_PROMO_CODE})",
    )
    parser.add_argument("--retries", type=int, default=3, help="nombre de reprises")
    parser.add_argument("--delay", type=float, default=2.0, help="délai entre reprises")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        parser.error("--base-url doit commencer par http:// ou https://")

    promo_code = args.promo_code.strip().upper()
    if not 3 <= len(promo_code) <= 32 or not all(
        char.isalnum() or char in "-_" for char in promo_code
    ):
        parser.error("--promo-code doit contenir 3 à 32 lettres, chiffres, - ou _")

    cache_bust = str(int(time.time()))
    last_error = None
    for attempt in range(args.retries + 1):
        try:
            result = run_once(base_url, args.handle, promo_code, cache_bust)
        except SmokeError as error:
            last_error = error
            if attempt >= args.retries:
                break
            print(
                f"Tentative {attempt + 1}/{args.retries + 1} échouée : {error}",
                file=sys.stderr,
            )
            time.sleep(args.delay)
        else:
            multi = result["multi"]
            promo = result["promo"]
            print("Smoke test OK.")
            print(f"Storefront : {base_url}")
            print(
                f"Prix Nitro : {result['price'].get('amountCents')} centimes "
                f"({EXPECTED_LABEL})"
            )
            print(
                f"Panier {len(CART)} articles : {multi.get('subtotalCents')} centimes "
                f"({multi.get('amountLabel')})"
            )
            print(
                f"Promo {promo.get('promo', {}).get('code')} : "
                f"-{promo.get('discountCents')} centimes -> "
                f"{promo.get('totalCents')} centimes ({promo.get('amountLabel')})"
            )
            print(
                f"Code inconnu : refuse (HTTP {result['invalid'][0]} {result['invalid'][1]})"
            )
            print(f"Lien PayPal : {result['single_link']}")
            return 0

    print(f"Smoke test échoué : {last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
