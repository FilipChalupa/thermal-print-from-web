import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createConnection } from 'net'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { stream, streamSSE } from 'hono/streaming'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { getConfig, removePrinter, setConfig, upsertPrinter } from './config.js'
import { discoverPrinters, discoverPrintersStream, pickDefaultPrinter } from './discovery.js'
import { getJobLog, logJob } from './jobs-log.js'
import { startIppHttpServer } from './ipp/http.js'
import { startMdns } from './ipp/mdns.js'
import { printImage, printTestReceipt } from './printer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = join(__dirname, '..', 'public')

// Live runtime status for /health.
const runtime = { ippPort: 0, ippRunning: false, mdnsAdvertising: false }

/** Quick TCP reachability check of a thermal printer's raw-print port. */
function isReachable(ip: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ip) return resolve(false)
    const socket = createConnection({ host: ip, port: 9100 })
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
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
    for (let i = 0; i < imageFiles.length; i++) {
      const image = imageFiles[i]
      if (!(image instanceof File)) continue

      await s.write(JSON.stringify({
        type: 'progress',
        current: i + 1,
        total: imageFiles.length,
        name: image.name,
      }) + '\n')

      try {
        const buffer = Buffer.from(await image.arrayBuffer())
        await printImage(ip, buffer, copies)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Chyba při tisku'
        logJob({ source: 'web', printerIp: ip, name: image.name, status: 'error', error: message })
        await s.write(JSON.stringify({ type: 'error', message }) + '\n')
        return
      }
    }

    logJob({ source: 'web', printerIp: ip, name: `${imageFiles.length}× obrázek`, pages: imageFiles.length, status: 'ok' })
    await s.write(JSON.stringify({ type: 'done' }) + '\n')
  })
})

// Configuration for the virtual (driverless) printer: the target thermal
// printer IP and the advertised name. Used by IPP jobs, which carry no IP.
function publicConfig() {
  const cfg = getConfig()
  return { printerIp: cfg.printerIp, printerName: cfg.printerName, paperWidthDots: cfg.paperWidthDots }
}

app.get('/config', (c) => c.json(publicConfig()))

app.post('/config', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: { printerIp?: string; printerName?: string; paperWidthDots?: number } = {}
  if (typeof body.printerIp === 'string') patch.printerIp = body.printerIp.trim()
  if (typeof body.printerName === 'string' && body.printerName.trim()) patch.printerName = body.printerName.trim()
  if (body.paperWidthDots === 384 || body.paperWidthDots === 576) patch.paperWidthDots = body.paperWidthDots
  setConfig(patch)
  return c.json(publicConfig())
})

// Saved / renamed printers, kept across reloads.
app.get('/printers', (c) => c.json({ printers: getConfig().printers }))

app.put('/printers', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!ip || !name) return c.json({ error: 'ip a name jsou povinné' }, 400)
  return c.json({ printers: upsertPrinter(ip, name) })
})

app.delete('/printers', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  if (!ip) return c.json({ error: 'ip je povinná' }, 400)
  return c.json({ printers: removePrinter(ip) })
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

// Liveness + capability status for healthchecks and debugging.
app.get('/health', async (c) => {
  const cfg = getConfig()
  const printerReachable = await isReachable(cfg.printerIp)
  return c.json({
    ok: true,
    ipp: { running: runtime.ippRunning, port: runtime.ippPort },
    mdns: { advertising: runtime.mdnsAdvertising },
    printer: { ip: cfg.printerIp, reachable: printerReachable },
  })
})

// Print a text test receipt (name + IP) to a single printer.
app.post('/print-test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const ip = typeof body.ip === 'string' ? body.ip.trim() : ''
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Termální tiskárna'
  if (!ip) return c.json({ error: 'IP je povinná' }, 400)
  try {
    await printTestReceipt(ip, name, ip)
    logJob({ source: 'test', printerIp: ip, name: `Test: ${name}`, status: 'ok' })
    return c.json({ ok: true })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Chyba tisku'
    logJob({ source: 'test', printerIp: ip, name: `Test: ${name}`, status: 'error', error })
    return c.json({ ok: false, error }, 502)
  }
})

// Print a test receipt to every discovered printer.
app.post('/print-test-all', async (c) => {
  const printers = await discoverPrinters()
  const results = []
  for (const p of printers) {
    try {
      await printTestReceipt(p.ip, p.name ?? 'Termální tiskárna', p.ip)
      results.push({ ip: p.ip, ok: true })
    } catch (err) {
      results.push({ ip: p.ip, ok: false, error: err instanceof Error ? err.message : 'Chyba tisku' })
    }
  }
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
    const printers = await discoverPrinters()
    if (getConfig().printerIp) return
    const pick = pickDefaultPrinter(printers)
    if (pick) {
      setConfig({ printerIp: pick.ip })
      console.log(`Automaticky vybrána tiskárna pro systémový tisk: ${pick.name ?? pick.ip} (${pick.ip})`)
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

      if (!enableIpp) {
        resolve({ port: info.port })
        return
      }

      // The virtual printer must be reachable from the whole LAN, so it always
      // binds to 0.0.0.0 regardless of how the web UI is bound.
      try {
        const ipp = await startIppHttpServer({ port: options.ippPort ?? (Number(process.env.IPP_PORT) || 6310) })
        startMdns({ port: ipp.port })
        runtime.ippPort = ipp.port
        runtime.ippRunning = true
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
