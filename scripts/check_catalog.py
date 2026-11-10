#!/usr/bin/env python3
"""Garde-fou du catalogue EGO Market.

Deux règles sont vérifiées avant le build :
- aucune marque retirée (scripts/catalog-policy.json) ne réapparaît dans les
  données, les cartes, les prix serveur ou une fiche produit ;
- chaque produit du catalogue n'a qu'une carte, qu'une entrée JSON et qu'un
  prix serveur, et les trois prix concordent.

Les prix identiques entre deux produits différents sont normaux (beaucoup de
produits coûtent 0,49 €). Le contrôle ne bloque donc pas cela : il bloque les
doublons et les contradictions de prix pour un même produit.
"""

from collections import Counter
from decimal import Decimal, InvalidOperation
import html
import json
import re
import sys
import unicodedata
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = ROOT / "scripts" / "catalog-policy.json"
PRODUCTS_JSON = ROOT / "scripts" / "ego-products.json"
CATALOG_HTML = ROOT / "ego-storefront" / "products" / "index.html"
PRICING_HTML = ROOT / "ego-storefront" / "pricing" / "index.html"
PRICES_TS = ROOT / "src" / "worker" / "prices.ts"
PRODUCT_PAGES = ROOT / "ego-storefront" / "product"

CARD_RE = re.compile(
    r'<article\b[^>]*\bclass="[^"]*\bproduct-card\b[^"]*"[^>]*>.*?</article>',
    re.S | re.I,
)
CARD_OPEN_RE = re.compile(
    r'<article\b[^>]*\bclass="[^"]*\bproduct-card\b[^"]*"[^>]*>',
    re.S | re.I,
)
PRICE_ENTRY_RE = re.compile(
    r'"([^"]+)"\s*:\s*\{\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*amountCents:\s*(\d+)\s*\}',
    re.S,
)
PRICE_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
TAG_RE = re.compile(r"<[^>]+>", re.S)


def normalize(text):
    """Compare les noms sans tenir compte de la casse, des accents ni des tirets."""
    text = unicodedata.normalize("NFKD", str(text))
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def brand_hits(text, brands):
    normalized = normalize(text)
    hits = []
    for brand in brands:
        pattern = re.escape(normalize(brand))
        if pattern and re.search(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", normalized):
            hits.append(brand)
    return hits


def strip_tags(fragment):
    return html.unescape(TAG_RE.sub(" ", fragment)).strip()


def read_text(path):
    if not path.exists():
        raise ValueError(f"fichier introuvable : {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def load_brands():
    try:
        policy = json.loads(read_text(POLICY_PATH))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"impossible de lire scripts/catalog-policy.json : {error}")

    brands = policy.get("blockedBrands")
    if not isinstance(brands, list) or not brands:
        raise ValueError("catalog-policy.json doit contenir une liste blockedBrands non vide")
    if any(not isinstance(brand, str) or not brand.strip() for brand in brands):
        raise ValueError("chaque marque bloquée doit être une chaîne non vide")
    return brands


def load_products():
    try:
        products = json.loads(read_text(PRODUCTS_JSON))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"impossible de lire scripts/ego-products.json : {error}")

    if not isinstance(products, list) or not products:
        raise ValueError("scripts/ego-products.json doit être une liste non vide")

    for index, product in enumerate(products, start=1):
        if not isinstance(product, dict):
            raise ValueError(f"produit JSON #{index} invalide")
        for field in ("name", "href", "price"):
            if not isinstance(product.get(field), str) or not product[field].strip():
                raise ValueError(f"produit JSON #{index} : champ {field} manquant")
    return products


def load_cards():
    catalog = read_text(CATALOG_HTML)
    blocks = CARD_RE.findall(catalog)
    openings = CARD_OPEN_RE.findall(catalog)
    if len(blocks) != len(openings):
        raise ValueError("une carte catalogue est mal fermée ou mal formée")

    cards = []
    for block in blocks:
        attrs = dict(
            re.findall(r'\bdata-(cat|name|price|order)="([^"]*)"', block, re.S)
        )
        href = re.search(r'<a\b[^>]*\bhref="([^"]+)"', block, re.S)
        shown_price = re.search(
            r'<span\b[^>]*\bclass="[^"]*\bprice\b[^"]*"[^>]*>(.*?)</span>',
            block,
            re.S,
        )
        if not href or not shown_price or not attrs.get("name") or not attrs.get("price"):
            raise ValueError("une carte catalogue ne contient pas nom, lien, prix et data-price")

        cards.append(
            {
                "name": html.unescape(attrs["name"]),
                "href": html.unescape(href.group(1)),
                "price": strip_tags(shown_price.group(1)),
                "data_price": html.unescape(attrs["price"]),
            }
        )
    return cards


def load_server_prices():
    prices_text = read_text(PRICES_TS)
    entries = PRICE_ENTRY_RE.findall(prices_text)
    if not entries:
        raise ValueError("aucun prix trouvé dans src/worker/prices.ts")

    prices = {}
    duplicates = []
    for slug, name, cents in entries:
        if slug in prices:
            duplicates.append(slug)
        prices[slug] = {
            "name": html.unescape(name),
            "amount": Decimal(cents) / Decimal(100),
        }
    return prices, duplicates


def price_values(raw, label, errors):
    values = [
        Decimal(number.replace(",", "."))
        for number in PRICE_NUMBER_RE.findall(html.unescape(str(raw)))
    ]
    if not values:
        errors.append(f"{label} : aucun montant lisible dans « {raw} »")
        return []
    return values


def slug_from_href(href):
    parts = href.strip("/").split("/")
    if len(parts) >= 2 and parts[0] == "product":
        return parts[1]
    return Path(href).parent.name if href.endswith("/index.html") else Path(href).name


def check_brand_absence(brands, products, cards, server_prices, errors):
    records = []
    for product in products:
        records.append(("scripts/ego-products.json", product["name"], product["href"]))
    for card in cards:
        records.append(("catalogue", card["name"], card["href"]))
    for slug, entry in server_prices.items():
        records.append(("src/worker/prices.ts", entry["name"], slug))

    for page in sorted(PRODUCT_PAGES.glob("*/index.html")):
        text = page.read_text(encoding="utf-8")
        title = re.search(r"<title\b[^>]*>(.*?)</title>", text, re.S | re.I)
        heading = re.search(r"<h1\b[^>]*>(.*?)</h1>", text, re.S | re.I)
        records.append(
            (
                str(page.relative_to(ROOT)),
                page.parent.name,
                strip_tags(title.group(1)) if title else "",
                strip_tags(heading.group(1)) if heading else "",
            )
        )

    if PRICING_HTML.exists():
        pricing = read_text(PRICING_HTML)
        for href, label in re.findall(
            r'<a\b[^>]*href="([^"]*?/product/[^"]*)"[^>]*>(.*?)</a>',
            pricing,
            re.S | re.I,
        ):
            records.append(
                ("ego-storefront/pricing/index.html", strip_tags(label), html.unescape(href))
            )

    for record in records:
        source, label, *values = record
        text = " ".join(value for value in (label, *values) if value)
        hits = brand_hits(text, brands)
        for brand in hits:
            errors.append(f"marque retirée « {brand} » détectée dans {source} : {label}")


def check_price_consistency(products, cards, server_prices, server_duplicates, errors):
    for slug in server_duplicates:
        errors.append(f"prix serveur dupliqué pour le produit « {slug} »")

    href_counts = Counter(product["href"] for product in products)
    for href, count in href_counts.items():
        if count > 1:
            errors.append(f"produit dupliqué dans scripts/ego-products.json : {href} ({count} entrées)")

    card_counts = Counter(card["href"] for card in cards)
    for href, count in card_counts.items():
        if count > 1:
            errors.append(f"carte catalogue dupliquée : {href} ({count} cartes)")

    if len(products) != len(cards):
        errors.append(
            f"{len(products)} produits JSON contre {len(cards)} cartes catalogue : "
            "chaque produit doit avoir exactement une carte"
        )

    products_by_href = {product["href"]: product for product in products}
    cards_by_href = {card["href"]: card for card in cards}

    for href, product in products_by_href.items():
        card = cards_by_href.get(href)
        if card is None:
            errors.append(f"carte catalogue manquante pour {href}")
            continue

        slug = slug_from_href(href)
        json_prices = price_values(product["price"], f"prix JSON de {slug}", errors)
        card_prices = price_values(card["price"], f"prix carte de {slug}", errors)
        if not json_prices or not card_prices:
            continue

        if normalize(product["price"]) != normalize(card["price"]):
            errors.append(
                f"prix affiché différent du JSON pour {slug} : "
                f"carte « {card['price']} », JSON « {product['price']} »"
            )

        try:
            data_price = Decimal(card["data_price"].replace(",", "."))
        except InvalidOperation:
            errors.append(f"data-price invalide pour {slug} : « {card['data_price']} »")
        else:
            if data_price != min(json_prices):
                errors.append(
                    f"data-price incohérent pour {slug} : {card['data_price']} "
                    f"alors que le prix minimum est {min(json_prices)}"
                )

        server = server_prices.get(slug)
        if server is None:
            errors.append(f"prix serveur manquant pour {slug}")
            continue

        if server["amount"] < min(json_prices) or server["amount"] > max(json_prices):
            errors.append(
                f"prix serveur hors barème pour {slug} : {server['amount']} € "
                f"n'est pas compris dans « {product['price']} »"
            )

    for href, card in cards_by_href.items():
        if href not in products_by_href:
            errors.append(f"carte catalogue sans produit JSON : {href}")


def main():
    errors = []
    try:
        brands = load_brands()
        products = load_products()
        cards = load_cards()
        server_prices, server_duplicates = load_server_prices()
    except (OSError, ValueError) as error:
        print(f"Contrôle catalogue impossible : {error}", file=sys.stderr)
        return 1

    check_brand_absence(brands, products, cards, server_prices, errors)
    check_price_consistency(products, cards, server_prices, server_duplicates, errors)

    if errors:
        print(f"Contrôle catalogue échoué : {len(errors)} problème(s).", file=sys.stderr)
        for error in errors:
            print(f" - {error}", file=sys.stderr)
        return 1

    print(
        f"Contrôle catalogue OK : {len(products)} produits, {len(cards)} cartes, "
        f"{len(server_prices)} prix serveur, {len(brands)} marques bloquées."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
