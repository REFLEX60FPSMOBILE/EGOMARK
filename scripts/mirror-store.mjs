// Miroir statique d'un storefront : pages publiques, CSS, polices, images et vidéos.
// Les scripts Next.js sont retirés : la copie est visuelle, sans panier/auth/paiement.
// Construit dans un dossier temporaire puis remplace le storefront après succès.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ORIGIN = (process.env.MIRROR_ORIGIN || '').replace(/\/+$/, '');
if (!ORIGIN) {
  console.error('MIRROR_ORIGIN est requis (ex. https://exemple.com).');
  process.exit(1);
}
const FINAL_ROOT = path.resolve('ego-storefront');
let ROOT = FINAL_ROOT; // dossier de construction, puis dossier final après succès
const MAX_PAGES = 200;
const MAX_DEPTH = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FIX_SCRIPT = `(function () {
  function revealNode(node) {
    if (!node || !node.style) return;
    if (node.style.opacity === '0') node.style.opacity = '1';
    if (node.style.transform) node.style.transform = 'none';
  }

  function reveal() {
    var main = document.getElementById('main');
    if (!main) return;

    main.querySelectorAll(':scope > div[style*="opacity:0"]').forEach(function (node) {
      var isSkeleton = node.querySelector('.animate-shimmer') && !node.querySelector('a[href*="/product/"]');
      if (isSkeleton) node.remove();
      else revealNode(node);
    });

    document.querySelectorAll('div[hidden][id^="S:"]').forEach(function (node) {
      node.removeAttribute('hidden');
      while (node.firstChild) main.appendChild(node.firstChild);
      node.remove();
    });

    main.querySelectorAll(':scope > [style*="opacity"]').forEach(revealNode);
    main.removeAttribute('aria-busy');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal);
  } else {
    reveal();
  }
})();
`;

const pageCache = new Map(); // chemin -> HTML nettoyé
const assetCache = new Map(); // URL absolue -> chemin local public
const cssCache = new Map(); // URL absolue -> chemin local public
let assetCount = 0;
let assetBytes = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);

function extFromType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('text/css')) return 'css';
  if (t.includes('image/webp')) return 'webp';
  if (t.includes('image/png')) return 'png';
  if (t.includes('image/jpeg')) return 'jpg';
  if (t.includes('image/svg')) return 'svg';
  if (t.includes('image/avif')) return 'avif';
  if (t.includes('image/gif')) return 'gif';
  if (t.includes('video/webm')) return 'webm';
  if (t.includes('video/mp4')) return 'mp4';
  if (t.includes('font/woff2')) return 'woff2';
  if (t.includes('font/woff')) return 'woff';
  if (t.includes('application/font-woff2')) return 'woff2';
  return '';
}

function extFromPath(value) {
  try {
    const ext = path.extname(new URL(value, ORIGIN).pathname).toLowerCase();
    return ext ? ext.slice(1) : '';
  } catch {
    return '';
  }
}

function normalizePath(href) {
  try {
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN) return null;
    let pathname = decodeURIComponent(url.pathname).replace(/\/+/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, '');
    // Les liens statiques /.../index.html désignent la même page que /...
    if (pathname === '/index.html') pathname = '/';
    else if (pathname.endsWith('/index.html')) pathname = pathname.slice(0, -'/index.html'.length) || '/';
    return pathname;
  } catch {
    return null;
  }
}

function allowedPage(pathname) {
  if (pathname === '/') return true;
  if (/^\/(_next|api|uploads|brand|lusive)\//.test(pathname)) return false;
  if (['/products', '/pricing', '/seguidores', '/resellers', '/boxes', '/reviews', '/contact', '/contacts', '/faq'].includes(pathname)) return true;
  return pathname.startsWith('/product/') || pathname.startsWith('/documents/') || pathname.startsWith('/legal/');
}

function outPath(pathname) {
  if (pathname === '/') return 'index.html';
  return pathname.replace(/^\//, '') + '/index.html';
}

function stripScripts(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<link\b[^>]*\bas="script"[^>]*>/gi, '')
    .replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '');
}

function extractLinks(html) {
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    const raw = match[1].replace(/&amp;/g, '&').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    const pathname = normalizePath(raw);
    if (pathname && allowedPage(pathname)) links.add(pathname);
  }
  return [...links];
}

function upgradeSrcset(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const match = tag.match(/\bsrcset="([^"]+)"/i);
    if (!match) return tag;

    const candidates = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const pieces = part.split(/\s+/);
        const url = pieces[0];
        const descriptor = pieces[1] || '';
        let width = 0;
        if (/^\d+w$/i.test(descriptor)) width = parseInt(descriptor, 10);
        else if (/^\d+(\.\d+)?x$/i.test(descriptor)) width = parseFloat(descriptor) * 1000;
        return { url, width };
      })
      .sort((a, b) => a.width - b.width);

    if (!candidates.length) return tag;
    const chosen = candidates.filter((candidate) => candidate.width > 0 && candidate.width <= 1600).pop() || candidates[candidates.length - 1];
    let output = tag.replace(/\s*srcset="[^"]*"/i, '');
    if (/\bsrc="[^"]*"/i.test(output)) output = output.replace(/\bsrc="[^"]*"/i, `src="${chosen.url}"`);
    else output = output.replace(/<img\b/i, `<img src="${chosen.url}"`);
    return output;
  });
}

async function downloadAsset(rawValue, baseUrl) {
  let url;
  try {
    url = new URL(String(rawValue).replace(/&amp;/g, '&'), baseUrl);
  } catch {
    return rawValue;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return rawValue;
  if (url.origin !== ORIGIN) return url.href;
  if (assetCache.has(url.href)) return assetCache.get(url.href);

  let response;
  try {
    response = await fetch(url.href, { headers: { 'user-agent': UA, accept: '*/*' } });
  } catch (error) {
    console.warn('asset réseau KO', url.href, error.message);
    return rawValue;
  }
  if (!response.ok) {
    console.warn('asset', response.status, url.href);
    return rawValue;
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0];
  if (contentType.includes('text/html')) return rawValue;

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = extFromType(contentType) || extFromPath(url.href) || 'bin';
  const local = `assets/${sha(url.href)}.${ext}`;
  const absolute = path.join(ROOT, local);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);

  const publicPath = '/' + local;
  assetCache.set(url.href, publicPath);
  assetCount += 1;
  assetBytes += buffer.length;
  return publicPath;
}

async function processCss(rawUrl, baseUrl, depth = 0) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl).href;
  } catch {
    return rawUrl;
  }
  if (cssCache.has(url)) return cssCache.get(url);

  let response;
  try {
    response = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/css,*/*' } });
  } catch {
    return rawUrl;
  }
  if (!response.ok) return rawUrl;

  let css = await response.text();
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)];
  for (const match of matches) {
    const raw = match[2].trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    let local;
    if (/^https?:\/\//i.test(raw) && new URL(raw).pathname.toLowerCase().endsWith('.css') && depth < 3) {
      local = await processCss(raw, url, depth + 1);
    } else {
      local = await downloadAsset(raw, url);
    }
    css = css.split(match[0]).join(`url("${local}")`);
  }

  const local = `assets/css/${sha(url)}.css`;
  const absolute = path.join(ROOT, local);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, css);
  cssCache.set(url, '/' + local);
  return '/' + local;
}

async function processHtml(html, pagePath) {
  const baseUrl = ORIGIN + pagePath;
  html = upgradeSrcset(html);

  const stylesheetLinks = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)];
  for (const match of stylesheetLinks) {
    const tag = match[0];
    const hrefMatch = tag.match(/\bhref="([^"]+)"/i);
    if (!hrefMatch) continue;
    const local = await processCss(hrefMatch[1], baseUrl);
    html = html.replace(tag, tag.replace(hrefMatch[1], local));
  }

  const sourceAttributes = [...html.matchAll(/\b(src|poster)="([^"]+)"/gi)];
  for (const match of sourceAttributes) {
    const raw = match[2].replace(/&amp;/g, '&');
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    const local = await downloadAsset(raw, baseUrl);
    html = html.split(match[0]).join(`${match[1]}="${local}"`);
  }

  const inlineUrls = [...html.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)];
  for (const match of inlineUrls) {
    const raw = match[2].trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    const local = await downloadAsset(raw, baseUrl);
    html = html.split(match[0]).join(`url("${local}")`);
  }

  const iconLinks = [...html.matchAll(/<link\b[^>]*rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/gi)];
  for (const tag of iconLinks) {
    const hrefMatch = tag[0].match(/\bhref="([^"]+)"/i);
    if (!hrefMatch) continue;
    const local = await downloadAsset(hrefMatch[1], baseUrl);
    html = html.replace(tag[0], tag[0].replace(hrefMatch[1], local));
  }

  html = html
    .replace(/<link\b[^>]*rel="(?:preload|modulepreload|preconnect|dns-prefetch)"[^>]*>/gi, '')
    .replace(/(<link\b[^>]*rel="stylesheet"[^>]*?)\s+integrity="[^"]*"/gi, '$1')
    .replace(/(<link\b[^>]*rel="stylesheet"[^>]*?)\s+crossorigin(?:="[^"]*")?/gi, '$1');

  html = html.replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi, (tag, href) => {
    const raw = href.replace(/&amp;/g, '&').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(raw)) return tag;
    const pathname = normalizePath(raw);
    if (pathname && pageCache.has(pathname)) return tag.replace(href, '/' + outPath(pathname));
    if (pathname) return tag.replace(href, ORIGIN + pathname);
    return tag;
  });

  if (!html.includes('ego-theme.css')) {
    const themeLinks = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/assets/ego-theme.css">';
    html = html.replace('</head>', themeLinks + '</head>');
  }

  if (!html.includes('static-copy-fix.js')) {
    html = html.replace('</body>', '<script src="/assets/static-copy-fix.js"></script></body>');
  }

  return html;
}

function replaceStorefront(staging) {
  const backup = path.join(path.dirname(FINAL_ROOT), `.ego-storefront-backup-${crypto.randomUUID()}`);
  const hadExisting = fs.existsSync(FINAL_ROOT);

  if (hadExisting) fs.renameSync(FINAL_ROOT, backup);

  try {
    fs.renameSync(staging, FINAL_ROOT);
  } catch (error) {
    if (hadExisting && !fs.existsSync(FINAL_ROOT) && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, FINAL_ROOT);
      } catch (restoreError) {
        console.error('Restauration impossible depuis', backup, restoreError.message);
      }
    }
    throw error;
  }

  if (hadExisting) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn('Ancien storefront conservé dans', backup, error.message);
    }
  }
}

async function main() {
  const seeds = ['/', '/products', '/pricing', '/seguidores', '/resellers', '/boxes', '/reviews'];
  const queue = seeds.map((pathname) => ({ pathname, depth: 0 }));
  const queued = new Set(seeds);
  const seen = new Set();

  while (queue.length && seen.size < MAX_PAGES) {
    const { pathname, depth } = queue.shift();
    if (seen.has(pathname)) continue;
    seen.add(pathname);

    let response;
    try {
      response = await fetch(ORIGIN + pathname, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
      });
    } catch (error) {
      console.warn('page réseau KO', pathname, error.message);
      continue;
    }
    if (!response.ok) {
      console.warn('page', response.status, pathname);
      continue;
    }

    const rawHtml = await response.text();
    const html = stripScripts(rawHtml);
    pageCache.set(pathname, html);
    console.log(`[page ${seen.size}/${MAX_PAGES}] ${pathname} (${Math.round(html.length / 1024)} Ko)`);

    if (depth < MAX_DEPTH) {
      for (const link of extractLinks(html)) {
        if (!seen.has(link) && !queued.has(link)) {
          queued.add(link);
          queue.push({ pathname: link, depth: depth + 1 });
        }
      }
    }
    await sleep(80);
  }

  console.log(`\nPages collectées : ${pageCache.size}. Traitement des assets...\n`);

  if (pageCache.size === 0) {
    console.error('Aucune page collectée : le dossier de sortie reste inchangé.');
    process.exitCode = 1;
    return;
  }

  const staging = fs.mkdtempSync(path.join(path.dirname(FINAL_ROOT), '.ego-storefront-build-'));
  ROOT = staging;

  try {
    fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'assets', 'static-copy-fix.js'), FIX_SCRIPT);
    fs.copyFileSync(path.join('scripts', 'ego-theme.css'), path.join(ROOT, 'assets', 'ego-theme.css'));

    let pageIndex = 0;
    for (const [pathname, html] of pageCache.entries()) {
      pageIndex += 1;
      const processed = await processHtml(html, pathname);
      const destination = path.join(ROOT, outPath(pathname));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, processed);
      console.log(`[écrit ${pageIndex}/${pageCache.size}] ${outPath(pathname)} (${Math.round(processed.length / 1024)} Ko)`);
    }

    const summary = {
      pages: pageCache.size,
      assets: assetCount,
      css: cssCache.size,
      assetMB: Math.round((assetBytes / 1024 / 1024) * 10) / 10,
    };
    fs.writeFileSync(path.join(ROOT, 'mirror-report.json'), JSON.stringify(summary, null, 2));
    replaceStorefront(staging);
    console.log('\nTerminé:', summary);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
