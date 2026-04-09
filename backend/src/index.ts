import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
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

app.use('/*', serveStatic({ root: publicDir }))
app.use('/*', serveStatic({ path: join(publicDir, 'index.html') }))

serve({
  fetch: app.fetch,
  port: 3000,
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
