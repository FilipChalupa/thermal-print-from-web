import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { printImage } from './printer.js'

const app = new Hono()

app.use('/*', cors())

app.post('/print', async (c) => {
  const formData = await c.req.formData()

  const ip = formData.get('ip')
  const image = formData.get('image')
  const copiesRaw = formData.get('copies')

  if (!ip || typeof ip !== 'string') {
    return c.json({ error: 'IP address is required' }, 400)
  }

  if (!image || !(image instanceof File)) {
    return c.json({ error: 'Image is required' }, 400)
  }

  const copies = Math.max(1, Math.min(99, parseInt(copiesRaw as string) || 1))

  const arrayBuffer = await image.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  await printImage(ip, buffer, copies)

  return c.json({ success: true })
})

serve({
  fetch: app.fetch,
  port: 3000,
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
