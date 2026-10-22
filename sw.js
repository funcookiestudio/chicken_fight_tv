/* Service worker do Chicken Fight TV: depois da primeira visita o jogo abre offline.
   Ao publicar uma versão nova do jogo, aumente o número em VER (v3, v4...) para os celulares trocarem o cache. */
const VER = 'chicken-tv-v3';
const LOCAL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
const OPTIONAL = ['galo.jpg']; // papel de parede da tela inicial: só entra se o arquivo existir
const SCRIPTS = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Outfit:wght@400;600&display=swap';
const HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NAV_WAIT = 4000; // rede lenta: passado esse tempo abre a cópia guardada

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// fonte do Google: guarda o CSS e os arquivos de fonte que ele aponta, para o visual ser o mesmo offline
async function precacheFonts(c) {
  const r = await fetch(FONT_CSS, { mode: 'cors' });
  if (!r.ok) return;
  const css = await r.clone().text();
  await c.put(FONT_CSS, r);
  const files = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || [])];
  await Promise.all(files.map(u => fetch(u, { mode: 'cors' }).then(f => f.ok && c.put(u, f)).catch(() => {})));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    // cache:'reload' ignora o cache HTTP (o GitHub Pages guarda ~10 min) para não gravar arquivo velho
    await Promise.all(LOCAL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => r.ok && c.put(u, r)).catch(() => {})));
    // itens extras: se algum falhar, a instalação continua
    const tasks = [];
    for (const u of OPTIONAL) tasks.push(fetch(new Request(u, { cache: 'reload' })).then(r => r.ok && c.put(u, r)).catch(() => {}));
    for (const u of SCRIPTS) tasks.push(fetch(new Request(u, { mode: 'no-cors' })).then(r => c.put(u, r)).catch(() => {}));
    tasks.push(precacheFonts(c).catch(() => {}));
    await Promise.all(tasks);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !HOSTS.includes(url.hostname)) return;

  // página: rede primeiro (pega a atualização na hora); cache se estiver offline ou lenta
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const net = fetch(req, { cache: 'no-cache' }).then(r => {
        if (r.ok) { const cp = r.clone(); caches.open(VER).then(c => c.put('index.html', cp)).catch(() => {}); }
        return r;
      });
      try { return await withTimeout(net, NAV_WAIT); }
      catch (_) { return (await caches.match('index.html')) || net; }
    })());
    return;
  }

  // demais (scripts, fontes, imagens): cache primeiro, atualiza em segundo plano
  e.respondWith((async () => {
    const c = await caches.open(VER);
    const hit = await c.match(req, { ignoreVary: true });
    const net = fetch(req).then(r => {
      if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); c.put(req, cp).catch(() => {}); }
      return r;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
