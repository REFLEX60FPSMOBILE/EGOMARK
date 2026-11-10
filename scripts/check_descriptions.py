#!/usr/bin/env python3
"""Garde-fou des descriptions produit EGO Market.

Le contrôle refuse, dans les descriptions publiées :
- les puces résiduelles issues d'un copier-coller (·, •, ▪, ◦, ●, ‣, ∙, ⋅) ;
- les séparateurs décoratifs (barres ━ ─ ═ et suites ---, ___, ===, ***, ~~~) ;
- les éléments de liste vides ou réduits à un séparateur ;
- les meta de description vides ou absentes.

Il couvre les trois meta de description (description, og:description,
twitter:description) et chaque bloc <section class="lxv__desc"> des fiches
ego-storefront/product/*/index.html. Avec --built, il vérifie les mêmes
descriptions dans dist/storefront-assets, donc ce qui part réellement en ligne.
--path permet de pointer une fiche ou un dossier isolé (fixture de test).
"""

import argparse
from collections import Counter
import html
from pathlib import Path
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
PRODUCT_PAGES = ROOT / "ego-storefront" / "product"
BUILT_PRODUCT_PAGES = ROOT / "dist" / "storefront-assets" / "product"

META_KEYS = ("description", "og:description", "twitter:description")

# Puces décoratives qui ne doivent jamais rester dans une description.
BULLETS = "\u00b7\u2022\u25aa\u25e6\u25cf\u2023\u2219\u22c5"
# Barres de cadre/dessin : toujours décoratives dans une description.
BARS = "\u2501\u2500\u2550\u2504\u2505\u2508\u2509\u254c\u254d"
# Caractères utilisés par les lignes de séparation.
LINE_CHARS = "-_=*~" + BARS + "\u2014\u2013"
# Trois caractères de séparation identiques d'affilée : ---, ═══, ___, ***…
SEPARATOR_RUN_RE = re.compile(r"([-_=*~\u2500\u2501\u2550\u2014\u2013])\1{2,}")
ONLY_SEPARATORS_RE = re.compile(rf"^[\s{re.escape(BULLETS + LINE_CHARS)}]+$")
MEANINGLESS_RE = re.compile(rf"^[\s{re.escape(BULLETS + LINE_CHARS)}]*$")

META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.I)
META_ATTR_RE = re.compile(r'([a-zA-Z:-]+)\s*=\s*"([^"]*)"')
DESC_SECTION_RE = re.compile(
    r'<section\b[^>]*\bclass="[^"]*\blxv__desc\b[^"]*"[^>]*>.*?</section>',
    re.S | re.I,
)
LI_RE = re.compile(r"<li\b[^>]*>(.*?)</li>", re.S | re.I)
MEDIA_RE = re.compile(r"<(?:img|svg|picture|video|iframe)\b", re.I)
TAG_RE = re.compile(r"<[^>]+>", re.S)


def visible_text(fragment):
    """Texte visible d'un fragment HTML, entités comprises."""
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", fragment))).strip()


def inspect_text(label, text, errors):
    """Signale puces résiduelles et séparateurs décoratifs dans un texte."""
    text = html.unescape(text or "")

    if not text.strip():
        errors.append(f"{label} : description vide")
        return

    bullets = sorted({char for char in text if char in BULLETS})
    if bullets:
        errors.append(
            f"{label} : puce résiduelle « {' '.join(bullets)} »"
        )

    bars = sorted({char for char in text if char in BARS})
    if bars:
        errors.append(
            f"{label} : séparateur décoratif « {' '.join(bars)} »"
        )

    bar_only = bool(bars)
    for match in SEPARATOR_RUN_RE.finditer(text):
        if any(char in BARS for char in match.group(0)):
            continue  # déjà signalé par la puce de barres ci-dessus
        errors.append(f"{label} : séparateur décoratif « {match.group(0)} »")

    compact = re.sub(r"\s+", "", text)
    if not bar_only and len(compact) >= 3 and ONLY_SEPARATORS_RE.match(compact):
        errors.append(f"{label} : ligne de séparation « {text[:40].strip()} »")


def check_meta(page_label, text, errors):
    """Vérifie les trois meta de description d'une fiche."""
    found = {key: None for key in META_KEYS}

    for tag in META_TAG_RE.finditer(text):
        attrs = {
            name.lower(): value for name, value in META_ATTR_RE.findall(tag.group(0))
        }
        key = attrs.get("name") or attrs.get("property")
        if key in found and "content" in attrs:
            found[key] = html.unescape(attrs["content"])

    for key in META_KEYS:
        label = f"{page_label} (meta {key})"
        content = found[key]
        if content is None:
            errors.append(f"{label} : balise absente")
            continue
        inspect_text(label, content, errors)


def check_description_block(page_label, block, errors):
    """Vérifie un bloc section.lxv__desc et ses éléments de liste."""
    label = f"{page_label} (lxv__desc)"
    inspect_text(label, visible_text(block), errors)

    for item in LI_RE.finditer(block):
        inner = item.group(1)
        text = visible_text(inner)
        if not MEANINGLESS_RE.match(text):
            continue
        if MEDIA_RE.search(inner):
            continue
        shown = text[:40].strip() or "élément sans texte"
        errors.append(f"{label} : élément de liste vide ou séparateur « {shown} »")


def check_page(path):
    """Contrôle une fiche produit ; renvoie (erreurs, nb meta, nb blocs)."""
    errors = []
    page_label = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return [f"{page_label} : lecture impossible ({error})"], 0, 0

    check_meta(page_label, text, errors)

    blocks = DESC_SECTION_RE.findall(text)
    if not blocks:
        errors.append(f"{page_label} : bloc section.lxv__desc introuvable")
    for block in blocks:
        check_description_block(page_label, block, errors)

    return errors, len(META_KEYS) if blocks or errors else 0, len(blocks)


def collect_pages(target):
    if target is None:
        return sorted(PRODUCT_PAGES.glob("*/index.html")), "ego-storefront/product"
    path = Path(target)
    if path.is_dir():
        return sorted(path.rglob("*.html")), str(path)
    return [path], str(path)


def main():
    parser = argparse.ArgumentParser(
        description="Refuse les séparateurs décoratifs et puces résiduelles des descriptions produit."
    )
    parser.add_argument(
        "--built",
        action="store_true",
        help="contrôle dist/storefront-assets au lieu des sources",
    )
    parser.add_argument(
        "--path",
        help="fiche HTML ou dossier à contrôler à la place du catalogue complet",
    )
    args = parser.parse_args()

    target = None
    if args.path:
        target = args.path
    elif args.built:
        target = BUILT_PRODUCT_PAGES

    pages, label = collect_pages(target)
    if not pages:
        print(f"Contrôle descriptions impossible : aucune fiche dans {label}", file=sys.stderr)
        return 1

    errors = []
    meta_total = 0
    block_total = 0
    for page in pages:
        page_errors, meta_count, block_count = check_page(page)
        errors.extend(page_errors)
        meta_total += meta_count
        block_total += block_count

    # Un même texte répété dans trois meta ne doit pas tripler le rapport.
    unique_errors = list(dict.fromkeys(errors))
    duplicates = Counter(errors)

    if unique_errors:
        detail = sum(duplicates[error] for error in unique_errors)
        print(
            f"Contrôle descriptions échoué : {detail} problème(s) "
            f"({len(unique_errors)} distinct(s)).",
            file=sys.stderr,
        )
        for error in unique_errors:
            count = duplicates[error]
            suffix = f" ({count} occurrences)" if count > 1 else ""
            print(f" - {error}{suffix}", file=sys.stderr)
        return 1

    print(
        f"Contrôle descriptions OK : {len(pages)} fiches, {meta_total} meta, "
        f"{block_total} blocs lxv__desc, 0 puce ni séparateur résiduel."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
