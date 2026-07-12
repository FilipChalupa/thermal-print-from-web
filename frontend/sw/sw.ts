/// <reference lib="webworker" />
// Custom service worker: offline app-shell caching + Web Share Target.
// Built by vite-plugin-pwa (injectManifest). `self.__WB_MANIFEST` is replaced
// at build time with the precache manifest — we cache those URLs by hand so we
// don't need the whole Workbox runtime.

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string }> }

const CACHE = 'thermal-print-shell-v1'
const SHARE_CACHE = 'thermal-print-shared'
const SHARE_PATH = '/share-target'

// API/backend routes the SW must never cache or shadow with the app shell.
const BACKEND = /^\/(print|print-test|print-test-all|config|discover|printers|virtual-printers|jobs|queue|drawer|health|share-target)/

const PRECACHE = ['/', ...self.__WB_MANIFEST.map((e) => (typeof e === 'string' ? e : e.url))]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Web Share Target: the OS POSTs the shared image(s) here.
  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(req))
    return
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (BACKEND.test(url.pathname)) return

  // Navigations: network-first so the app stays fresh, shell fallback offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/').then((r) => r ?? Response.error())))
    return
  }

  // Static assets: cache-first, filling the cache on first network hit.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          return res
        }),
    ),
  )
})

// Stash shared files in a cache the page can read, then redirect into the app.
async function handleShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const files = form.getAll('images').filter((v): v is File => v instanceof File)
    const cache = await caches.open(SHARE_CACHE)
    for (const key of await cache.keys()) await cache.delete(key)
    let i = 0
    for (const file of files) {
      const headers = new Headers({
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name || `sdilene-${i}.jpg`),
      })
      await cache.put(`/shared-image/${i}`, new Response(file, { headers }))
      i++
    }
  } catch {
    /* ignore — worst case the app opens with no images */
  }
  return Response.redirect('/?share-target=1', 303)
}
