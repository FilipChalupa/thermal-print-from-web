import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { stream, streamSSE } from 'hono/streaming'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  addPrinter,
  DITHER_ALGORITHMS,
  getAdvertisedPrinters,
  getConfig,
  getDefaultPrinter,
  getPrinters,
  removePrinter,
  setConfig,
  setDefaultPrinter,
  updatePrinter,
} from './config.js'
import { discoverPrinters, discoverPrintersStream, pickDefaultPrinter } from './discovery.js'
import { getJobEntry, getJobLog, getJobPayload } from './jobs-log.js'
import { enqueuePrint } from './print-queue.js'
import { getPrinterStatus, refreshPrinterStatus, startPrinterMonitor } from './printer-status.js'
import { startIppHttpServer } from './ipp/http.js'
import { startMdns } from './ipp/mdns.js'
import type { MdnsHandle } from './ipp/mdns.js'
import { buildImagesPayload, buildTestPayload, sendEscPos } from './printer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = join(__dirname, '..', 'public')

// Live runtime status for /health.
const runtime: { ippPort: number; ippRunning: boolean; mdnsAdvertising: boolean; mdns?: MdnsHandle } = {
  ippPort: 0,
  ippRunning: false,
  mdnsAdvertising: false,
}

/** Re-advertise mDNS (after the printer list or default changes) and re-probe. */
async function onPrintersChanged(): Promise<void> {
  void refreshPrinterStatus()
  if (!runtime.ippRunning) return
  try {
    await runtime.mdns?.stop()
    runtime.mdns = startMdns({ port: runtime.ippPort })
  } catch (err) {
    console.error('Nepodařilo se znovu ohlásit tiskárny přes mDNS:', err)
  }
}

const app = new Hono()

app.use('/*', cors())

app.post('/print', async (c) => {
  const formData = await c.req.formData()

  const ip = formData.get('ip')
  const imageFiles = formData.getAll('images')
  const copiesRaw = formData.get('copies')

  if (!ip || typeof ip !== 'string') {
    return c.json({ error: 'IP address is required' }, 400)
  }
  if (imageFiles.length === 0) {
    return c.json({ error: 'At least one image is required' }, 400)
  }

  const copies = Math.max(1, Math.min(99, parseInt(copiesRaw as string) || 1))

  return stream(c, async (s) => {
    await s.write(JSON.stringify({ type: 'progress', current: 1, total: 1, name: 'příprava' }) + '\n')
    try {
      const buffers: Buffer[] = []
      for (const image of imageFiles) {
        if (image instanceof File) buffers.push(Buffer.from(await image.arrayBuffer()))
      }
      const payload = await buildImagesPayload(buffers, copies)
      // The queue serializes with other jobs, retries if the printer is briefly
      // offline, and logs the job (with payload for reprint).
      await enqueuePrint(ip, payload, { source: 'web', name: `${buffers.length}× obrázek`, pages: buffers.length })
      await s.write(JSON.stringify({ type: 'done' }) + '\n')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chyba při tisku'
      await s.write(JSON.stringify({ type: 'error', message }) + '\n')
    }
  })
})

// Global print settings (image processing). Printers are managed via /printers.
function publicConfig() {
  const cfg = getConfig()
  return {
    paperWidthDots: cfg.paperWidthDots,
    ditherAlgorithm: cfg.ditherAlgorithm,
    brightness: cfg.brightness,
    contrast: cfg.contrast,
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))

app.get('/config', (c) => c.json(publicConfig()))

app.post('/config', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: Partial<ReturnType<typeof getConfig>> = {}
  if (body.paperWidthDots === 384 || body.paperWidthDots === 576) patch.paperWidthDots = body.paperWidthDots
  if (DITHER_ALGORITHMS.includes(body.ditherAlgorithm)) patch.ditherAlgorithm = body.ditherAlgorithm
  if (typeof body.brightness === 'number') patch.brightness = clamp(body.brightness, -100, 100)
  if (typeof body.contrast === 'number') patch.contrast = clamp(body.contrast, -100, 100)
  setConfig(patch)
  return c.json(publicConfig())
})

// Configured network printers — each is its own driverless (AirPrint) queue; the
// default one (defaultPrinterId) takes the canonical path and pre-selects prints.
function printersResponse() {
  const cfg = getConfig()
  return { printers: cfg.printers, defaultPrinterId: cfg.defaultPrinterId }
}

app.get('/printers', (c) => c.json(printersResponse()))

app.post('/printers', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  if (!name || !ip) return c.json({ error: 'name a ip jsou povinné' }, 400)
  const printer = addPrinter(name, ip)
  await onPrintersChanged()
  return c.json({ ...printersResponse(), printer })
})

app.put('/printers/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: { name?: string; ip?: string } = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (typeof body.ip === 'string' && body.ip.trim()) patch.ip = body.ip.trim()
  updatePrinter(c.req.param('id'), patch)
  await onPrintersChanged()
  return c.json(printersResponse())
})

app.delete('/printers/:id', async (c) => {
  removePrinter(c.req.param('id'))
  await onPrintersChanged()
  return c.json(printersResponse())
})

app.post('/printers/:id/default', async (c) => {
  setDefaultPrinter(c.req.param('id'))
  await onPrintersChanged()
  return c.json(printersResponse())
})

// Auto-discovery of nearby thermal printers (mDNS + port-9100 sweep) to power
// IP-address suggestions in the UI.
app.get('/discover', async (c) => {
  try {
    return c.json({ printers: await discoverPrinters() })
  } catch (err) {
    console.error('Discovery selhalo:', err)
    return c.json({ printers: [] })
  }
})

// Streaming discovery: emit each printer over SSE as soon as it is found, so the
// UI fills in live (mDNS instantly, port scan trickles in) instead of blocking.
app.get('/discover/stream', (c) =>
  streamSSE(c, async (s) => {
    const seen = new Set<string>()
    try {
      await discoverPrintersStream(async (printer) => {
        // De-dupe by IP, but let a later mDNS hit upgrade a bare scan result.
        const key = `${printer.ip}:${printer.source}`
        if (seen.has(key)) return
        seen.add(key)
        await s.writeSSE({ event: 'printer', data: JSON.stringify(printer) })
      })
    } catch (err) {
      console.error('Streaming discovery selhalo:', err)
    }
    await s.writeSSE({ event: 'done', data: '{}' })
  }),
)

// Recent print jobs across all channels (IPP / web / test).
app.get('/jobs', (c) => c.json({ jobs: getJobLog() }))

// Re-print a previous job from its retained payload.
app.post('/jobs/:id/reprint', async (c) => {
  const id = Number(c.req.param('id'))
  const entry = getJobEntry(id)
  const payload = getJobPayload(id)
  if (!entry || !payload) return c.json({ error: 'Úloha nebo její data nejsou k dispozici' }, 404)
  try {
    await enqueuePrint(entry.printerIp, payload, { source: 'reprint', name: entry.name, pages: entry.pages })
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Chyba tisku' }, 502)
  }
})

// Liveness + capability status for healthchecks and debugging.
app.get('/health', async (c) => {
  const st = getPrinterStatus()
  // Re-probe on demand when the cached value is missing or stale, so the UI badge
  // reacts within a poll rather than waiting for the background monitor.
  const fresh = st.reachable !== null && Date.now() - st.lastCheck < 5000
  if (!fresh) await refreshPrinterStatus()
  const now = getPrinterStatus()
  const jobs = getJobLog()
  return c.json({
    ok: true,
    ipp: {
      running: runtime.ippRunning,
      port: runtime.ippPort,
      printers: getAdvertisedPrinters().map((p) => ({ name: p.name, resourcePath: p.resourcePath, targetIp: p.targetIp })),
    },
    mdns: { advertising: runtime.mdnsAdvertising },
    printer: { ip: now.ip, reachable: now.reachable, online: now.online, paperOut: now.paperOut, coverOpen: now.coverOpen },
    jobs: { total: jobs.length, failures: jobs.filter((j) => j.status === 'error').length },
  })
})

// Print a text test receipt (name + IP) to a single printer.
app.post('/print-test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Termální tiskárna'
  if (!ip) return c.json({ error: 'IP je povinná' }, 400)
  try {
    await enqueuePrint(ip, buildTestPayload(name, ip), { source: 'test', name: `Test: ${name}` })
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Chyba tisku' }, 502)
  }
})

// Print a test receipt to every discovered printer.
app.post('/print-test-all', async (c) => {
  const printers = await discoverPrinters()
  const results = await Promise.all(
    printers.map(async (p) => {
      const name = p.name ?? 'Termální tiskárna'
      try {
        await enqueuePrint(p.ip, buildTestPayload(name, p.ip), { source: 'test', name: `Test: ${name}` })
        return { ip: p.ip, ok: true }
      } catch (err) {
        return { ip: p.ip, ok: false, error: err instanceof Error ? err.message : 'Chyba tisku' }
      }
    }),
  )
  return c.json({ results })
})

app.use('/*', serveStatic({ root: publicDir }))
app.use('/*', serveStatic({ path: join(publicDir, 'index.html') }))

export interface ServerHandle {
  /** Port of the web UI / REST server. */
  port: number
  /** Port of the LAN-facing IPP (virtual printer) server, if enabled. */
  ippPort?: number
}

/**
 * Run discovery in the background as soon as the server boots — ideally before
 * the user ever opens the web UI — so suggestions are ready instantly, and
 * auto-select the first printer found as the system-print target when none is
 * configured yet. Never overrides an existing choice.
 */
async function autoConfigurePrinter(): Promise<void> {
  try {
    if (getPrinters().length > 0) return
    const pick = pickDefaultPrinter(await discoverPrinters())
    if (pick) {
      addPrinter(pick.name ?? 'Termální tiskárna', pick.ip)
      console.log(`Automaticky přidána tiskárna: ${pick.name ?? pick.ip} (${pick.ip})`)
      await onPrintersChanged()
    }
  } catch (err) {
    console.error('Automatická volba tiskárny selhala:', err)
  }
}

export function startServer(
  options: { port?: number; hostname?: string; ipp?: boolean; ippPort?: number } = {},
): Promise<ServerHandle> {
  const enableIpp = options.ipp ?? true

  return new Promise((resolve) => {
    serve({
      fetch: app.fetch,
      port: options.port ?? 3000,
      hostname: options.hostname,
    }, async (info) => {
      console.log(`Server is running on http://localhost:${info.port}`)

      // Warm discovery + auto-select a target in the background (non-blocking).
      void autoConfigurePrinter()
      // Keep the target printer's online/offline status fresh for IPP + /health.
      startPrinterMonitor()

      if (!enableIpp) {
        resolve({ port: info.port })
        return
      }

      // The virtual printer must be reachable from the whole LAN, so it always
      // binds to 0.0.0.0 regardless of how the web UI is bound.
      try {
        const ipp = await startIppHttpServer({ port: options.ippPort ?? (Number(process.env.IPP_PORT) || 6310) })
        runtime.ippPort = ipp.port
        runtime.ippRunning = true
        runtime.mdns = startMdns({ port: ipp.port })
        runtime.mdnsAdvertising = true
        resolve({ port: info.port, ippPort: ipp.port })
      } catch (err) {
        console.error('Nepodařilo se spustit IPP/mDNS (tisková služba v síti):', err)
        resolve({ port: info.port })
      }
    })
  })
}

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isRunDirectly) {
  startServer({ port: Number(process.env.PORT) || 3000 })
}
