import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { getConfig, setConfig } from './config.js'
import { discoverPrinters, pickDefaultPrinter } from './discovery.js'
import { startIppHttpServer } from './ipp/http.js'
import { startMdns } from './ipp/mdns.js'
import { printImage } from './printer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = join(__dirname, '..', 'public')

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
        await s.write(JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : 'Chyba při tisku',
        }) + '\n')
        return
      }
    }

    await s.write(JSON.stringify({ type: 'done' }) + '\n')
  })
})

// Configuration for the virtual (driverless) printer: the target thermal
// printer IP and the advertised name. Used by IPP jobs, which carry no IP.
app.get('/config', (c) => {
  const cfg = getConfig()
  return c.json({ printerIp: cfg.printerIp, printerName: cfg.printerName })
})

app.post('/config', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: { printerIp?: string; printerName?: string } = {}
  if (typeof body.printerIp === 'string') patch.printerIp = body.printerIp.trim()
  if (typeof body.printerName === 'string' && body.printerName.trim()) patch.printerName = body.printerName.trim()
  const cfg = setConfig(patch)
  return c.json({ printerIp: cfg.printerIp, printerName: cfg.printerName })
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
