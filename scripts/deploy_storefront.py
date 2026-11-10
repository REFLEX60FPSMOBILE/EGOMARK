#!/usr/bin/env python3
"""Vérification post-déploiement du storefront EGO Market.

Le storefront est publié par l'outil Sites, sans CLI de déploiement : ce script
ne publie rien. Il construit les assets, lit l'empreinte publiée dans
/build.json, attend que la production serve exactement cette empreinte, puis
exécute scripts/smoke_prod.py. Le smoke test suit donc chaque déploiement et ne
peut pas valider une version périmée.

Utilisation après (ou pendant) une publication :

    npm run deploy:store
    python scripts/deploy_storefront.py --no-build --timeout 60
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
BUILD_FILE = ROOT / "dist" / "storefront-assets" / "build.json"
DESCRIPTIONS_SCRIPT = ROOT / "scripts" / "check_public_descriptions.py"
SMOKE_SCRIPT = ROOT / "scripts" / "smoke_prod.py"
DEFAULT_BASE_URL = "https://egomarket.freebuff.page"
USER_AGENT = "EGO-deploy-check/1.0"


class DeployError(RuntimeError):
    pass


def run_build():
    print("Build du storefront ...", flush=True)
    result = subprocess.run("npm run build:store", cwd=ROOT, shell=True)
    if result.returncode != 0:
        raise DeployError("build:store a échoué, déploiement non vérifié")


def local_build_id():
    try:
        data = json.loads(BUILD_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise DeployError(
            "dist/storefront-assets/build.json introuvable : lancez npm run build:store"
        )
    except (OSError, ValueError) as error:
        raise DeployError(f"dist/storefront-assets/build.json illisible : {error}")

    build_id = data.get("buildId")
    if not isinstance(build_id, str) or not build_id:
        raise DeployError("dist/storefront-assets/build.json ne contient pas de buildId")
    return build_id


def fetch_remote_build(base_url):
    url = f"{base_url}/build.json?deploy={time.time_ns()}"
    request = Request(
        url,
        headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except HTTPError as error:
        raise DeployError(f"GET /build.json : HTTP {error.code}") from error
    except URLError as error:
        raise DeployError(f"GET /build.json : {error.reason}") from error
    except (OSError, ValueError) as error:
        raise DeployError(f"GET /build.json : réponse illisible ({error})") from error

    if not isinstance(payload, dict):
        raise DeployError("GET /build.json : réponse inattendue")
    return payload


def wait_for_build(base_url, build_id, timeout, interval):
    started = time.monotonic()
    deadline = started + max(timeout, 0.0)
    attempt = 0

    while True:
        attempt += 1
        failure = None
        remote_id = None
        try:
            remote_id = fetch_remote_build(base_url).get("buildId")
        except DeployError as error:
            failure = str(error)

        if remote_id == build_id:
            elapsed = time.monotonic() - started
            print(
                f"Build {build_id} en ligne après {elapsed:.1f} s "
                f"({attempt} vérification(s))."
            )
            return

        if time.monotonic() >= deadline:
            if failure:
                raise DeployError(
                    f"{failure} — la production ne sert pas encore le build {build_id}"
                )
            raise DeployError(
                f"{base_url} sert le build {remote_id!r} au lieu de {build_id!r}"
            )

        if attempt == 1 or attempt % 6 == 0:
            detail = f" ({failure})" if failure else ""
            print(
                f"En attente du déploiement du build {build_id}{detail} ...",
                file=sys.stderr,
            )
        time.sleep(interval)


def run_public_descriptions(base_url):
    print("Vérification des descriptions publiques ...", flush=True)
    result = subprocess.run(
        [sys.executable, str(DESCRIPTIONS_SCRIPT), "--base-url", base_url],
        cwd=ROOT,
    )
    if result.returncode != 0:
        raise DeployError("descriptions publiques non conformes")


def run_smoke(base_url):
    print("Smoke test post-déploiement ...", flush=True)
    result = subprocess.run(
        [sys.executable, str(SMOKE_SCRIPT), "--base-url", base_url],
        cwd=ROOT,
    )
    if result.returncode != 0:
        raise DeployError("smoke test post-déploiement en échec")


def main():
    parser = argparse.ArgumentParser(
        description="Attend la mise en ligne du build storefront puis lance le smoke test."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SMOKE_BASE_URL", DEFAULT_BASE_URL),
        help="URL du storefront (défaut : production EGO Market)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="attente maximale du déploiement en secondes (défaut : 300)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=5.0,
        help="délai entre deux vérifications en secondes (défaut : 5)",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="ne pas relancer build:store avant la vérification",
    )
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        parser.error("--base-url doit commencer par http:// ou https://")
    if args.interval <= 0:
        parser.error("--interval doit être strictement positif")

    try:
        if not args.no_build:
            run_build()
        build_id = local_build_id()
        print(f"Build attendu : {build_id} sur {base_url}")
        wait_for_build(base_url, build_id, args.timeout, args.interval)
        run_public_descriptions(base_url)
        run_smoke(base_url)
    except DeployError as error:
        print(f"Vérification de déploiement échouée : {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Vérification de déploiement interrompue.", file=sys.stderr)
        return 130

    print("Déploiement vérifié : build en ligne et smoke test OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
