#!/usr/bin/env python3
"""Vérifie en ligne les descriptions produit nettoyées.

Après un déploiement, contrôle chaque fiche publique : les trois meta de
description et le bloc <section class="lxv__desc"> ne doivent contenir ni puce
résiduelle (·, •, ▪, ◦, ●) ni séparateur décoratif (━, ---, ___, ===), et aucun
<li> ne doit être vide ou réduit à un séparateur.

Les règles sont celles de scripts/check_descriptions.py : local et public
restent alignés. Par défaut, toutes les fiches du build sont contrôlées ;
--slug limite à une ou plusieurs fiches.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
BUILT_PRODUCTS = ROOT / "dist" / "storefront-assets" / "product"
DEFAULT_BASE_URL = "https://egomarket.freebuff.page"
USER_AGENT = "EGO-smoke-test/1.0"
META_COUNT = 3

sys.path.insert(0, str(ROOT / "scripts"))
import check_descriptions as rules  # noqa: E402


class PublicCheckError(RuntimeError):
    pass


def built_slugs():
    if not BUILT_PRODUCTS.is_dir():
        raise PublicCheckError(
            f"build introuvable ({BUILT_PRODUCTS.relative_to(ROOT)}) : lancez npm run build:store"
        )
    slugs = sorted(page.parent.name for page in BUILT_PRODUCTS.glob("*/index.html"))
    if not slugs:
        raise PublicCheckError("aucune fiche produit dans le build")
    return slugs


def fetch_page(base_url, slug, timeout, retries):
    url = f"{base_url}/product/{quote(slug)}/?descriptions={int(time.time() * 1000)}"
    last_error = None
    for attempt in range(retries + 1):
        request = Request(
            url,
            headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"},
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise PublicCheckError(f"HTTP {response.status}")
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as error:
            last_error = f"HTTP {error.code}"
            if error.code < 500:
                break
        except URLError as error:
            last_error = str(error.reason)
        except OSError as error:
            last_error = str(error)
        if attempt < retries:
            time.sleep(1 + attempt)
    raise PublicCheckError(last_error or "échec inconnu")


def check_page(slug, text):
    """Applique les règles locales à une fiche publique."""
    errors = []
    label = f"product/{slug}"

    rules.check_meta(label, text, errors)

    blocks = rules.DESC_SECTION_RE.findall(text)
    if len(blocks) != 1:
        errors.append(f"{label} : {len(blocks)} bloc(s) lxv__desc au lieu d'un")
    for block in blocks:
        rules.check_description_block(label, block, errors)

    return errors, META_COUNT, len(blocks)


def main():
    parser = argparse.ArgumentParser(
        description="Contrôle en ligne les descriptions produit déployées."
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="URL du storefront (défaut : production EGO Market)",
    )
    parser.add_argument(
        "--slug",
        action="append",
        dest="slugs",
        help="fiche à contrôler (répétable, défaut : toutes les fiches du build)",
    )
    parser.add_argument("--workers", type=int, default=8, help="requêtes parallèles")
    parser.add_argument("--timeout", type=float, default=20.0, help="délai par requête")
    parser.add_argument("--retries", type=int, default=2, help="reprises par fiche")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        parser.error("--base-url doit commencer par http:// ou https://")
    if args.workers < 1:
        parser.error("--workers doit être au moins 1")

    try:
        slugs = args.slugs or built_slugs()
    except PublicCheckError as error:
        print(f"Contrôle des descriptions publiques impossible : {error}", file=sys.stderr)
        return 1

    def check(slug):
        try:
            text = fetch_page(base_url, slug, args.timeout, args.retries)
        except PublicCheckError as error:
            return [f"product/{slug} : {error}"], 0, 0
        return check_page(slug, text)

    errors = []
    meta_total = 0
    block_total = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for page_errors, meta_count, block_count in pool.map(check, slugs):
            errors.extend(page_errors)
            meta_total += meta_count
            block_total += block_count

    if errors:
        unique = list(dict.fromkeys(errors))
        print(
            f"Descriptions publiques non conformes : {len(errors)} problème(s) "
            f"sur {len(slugs)} fiche(s).",
            file=sys.stderr,
        )
        for error in unique[:40]:
            print(f" - {error}", file=sys.stderr)
        if len(unique) > 40:
            print(f" - … et {len(unique) - 40} autre(s)", file=sys.stderr)
        return 1

    print(
        f"Descriptions publiques OK : {len(slugs)} fiches, {meta_total} meta, "
        f"{block_total} blocs lxv__desc, 0 puce ni séparateur résiduel."
    )
    print(f"Storefront : {base_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
