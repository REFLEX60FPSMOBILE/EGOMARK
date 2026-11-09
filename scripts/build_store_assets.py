import io
import os
import re
import shutil
import sys
from PIL import Image

SRC = 'ego-storefront'
OUT = 'dist/storefront-assets'
MAX_WIDTH = 800
QUALITY = 78
LIMIT_BYTES = 10 * 1024 * 1024
LIMIT_FILES = 1000

files = {}
for dp, _, fns in os.walk(SRC):
    for fn in fns:
        p = os.path.join(dp, fn)
        rel = os.path.relpath(p, SRC).replace(os.sep, '/')
        files[rel] = p

refs = set()
pattern = re.compile(r'assets/[A-Za-z0-9._/-]+')
for rel, p in files.items():
    if rel.lower().endswith(('.html', '.css', '.js')):
        text = open(p, encoding='utf-8', errors='replace').read()
        for m in pattern.finditer(text):
            refs.add(m.group(0).rstrip('.,;:'))

missing = sorted(r for r in refs if r not in files)
if missing:
    print('References introuvables:', missing[:10])
    sys.exit(1)

if os.path.exists(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

copied = 0
for rel, p in files.items():
    if not rel.lower().endswith('.html'):
        continue
    dest = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(p, dest)
    copied += 1

encoded = 0
for rel in sorted(refs):
    p = files[rel]
    dest = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if rel.startswith('assets/ego-products/') and rel.lower().endswith('.webp'):
        with Image.open(p) as im:
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
            else:
                im = im.convert('RGB')
            if im.width > MAX_WIDTH:
                h = round(im.height * MAX_WIDTH / im.width)
                im = im.resize((MAX_WIDTH, h), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format='WEBP', quality=QUALITY, method=6)
            with open(dest, 'wb') as fh:
                fh.write(buf.getvalue())
        encoded += 1
    else:
        shutil.copy2(p, dest)
        copied += 1

total = 0
count = 0
for dp, _, fns in os.walk(OUT):
    for fn in fns:
        count += 1
        total += os.path.getsize(os.path.join(dp, fn))

print(
    'assets:',
    count,
    'fichiers,',
    round(total / 1048576, 2),
    'MiB | images re-encodees:',
    encoded,
    '| copies:',
    copied,
)
if count > LIMIT_FILES or total > LIMIT_BYTES:
    print('DEPASSE LA LIMITE Sites (1000 fichiers / 10 MiB)')
    sys.exit(1)
