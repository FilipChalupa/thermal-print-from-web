import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { printImage } from './printer.js'

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

  for (const image of imageFiles) {
    if (!(image instanceof File)) continue
    const buffer = Buffer.from(await image.arrayBuffer())
    await printImage(ip, buffer, copies)
  }

  return c.json({ success: true })
})

app.use('/*', serveStatic({ root: './public' }))
app.use('/*', serveStatic({ path: './public/index.html' }))

serve({
  fetch: app.fetch,
  port: 3000,
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
