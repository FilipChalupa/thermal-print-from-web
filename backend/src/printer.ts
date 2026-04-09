import { Canvas, loadImage } from 'skia-canvas'
import * as net from 'net'

const DOTS_PER_LINE = 576

function dither(imageData: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const pixels = new Float32Array(width * height)

  // Convert to grayscale luminance
  for (let i = 0; i < width * height; i++) {
    const r = imageData[i * 4]
    const g = imageData[i * 4 + 1]
    const b = imageData[i * 4 + 2]
    pixels[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  // Floyd-Steinberg dithering
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const old = pixels[idx]
      const newVal = old < 128 ? 0 : 255
      pixels[idx] = newVal
      const err = old - newVal

      if (x + 1 < width) pixels[idx + 1] += (err * 7) / 16
      if (y + 1 < height) {
        if (x - 1 >= 0) pixels[idx + width - 1] += (err * 3) / 16
        pixels[idx + width] += (err * 5) / 16
        if (x + 1 < width) pixels[idx + width + 1] += (err * 1) / 16
      }
    }
  }

  // Convert to 1-bit per pixel packed bytes
  const bytesPerRow = Math.ceil(width / 8)
  const result = new Uint8Array(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === 0) {
        const byteIndex = y * bytesPerRow + Math.floor(x / 8)
        result[byteIndex] |= 0x80 >> (x % 8)
      }
    }
  }
  return result
}

async function imageToEscPos(imageBuffer: Buffer): Promise<Buffer[]> {
  const img = await loadImage(imageBuffer)

  const printWidth = DOTS_PER_LINE
  const scale = printWidth / img.width
  const printHeight = Math.round(img.height * scale)

  const canvas = new Canvas(printWidth, printHeight)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, printWidth, printHeight)
  const imageData = ctx.getImageData(0, 0, printWidth, printHeight)

  const bits = dither(imageData.data as Uint8ClampedArray, printWidth, printHeight)
  const bytesPerRow = Math.ceil(printWidth / 8)
  const chunkHeight = 1024

  const buffers: Buffer[] = []

  for (let y = 0; y < printHeight; y += chunkHeight) {
    const h = Math.min(chunkHeight, printHeight - y)
    const xL = bytesPerRow & 0xff
    const xH = (bytesPerRow >> 8) & 0xff
    const yL = h & 0xff
    const yH = (h >> 8) & 0xff

    const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH])
    const data = Buffer.from(bits.slice(y * bytesPerRow, (y + h) * bytesPerRow))
    buffers.push(header, data)
  }

  return buffers
}

function socketWrite(host: string, port: number, data: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      for (const chunk of data) {
        socket.write(chunk)
      }
      setTimeout(() => {
        socket.end()
        resolve()
      }, 500)
    })
    socket.on('error', reject)
  })
}

export async function printImage(host: string, imageBuffer: Buffer, copies: number): Promise<void> {
  const PORT = 9100

  const init = Buffer.from([0x1b, 0x40])         // Initialize printer
  const centerAlign = Buffer.from([0x1b, 0x61, 1]) // Center alignment
  const cut = Buffer.from([0x1b, 0x69])            // Cut paper

  const imageChunks = await imageToEscPos(imageBuffer)

  const payload: Buffer[] = []
  payload.push(init, centerAlign)
  for (let i = 0; i < copies; i++) {
    payload.push(...imageChunks, cut)
  }

  await socketWrite(host, PORT, payload)
}
