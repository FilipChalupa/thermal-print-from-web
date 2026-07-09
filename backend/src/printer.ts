import { Canvas, Image, ImageData, loadImage } from 'skia-canvas'
import * as net from 'net'
import type { RasterPage } from './ipp/pwg-raster.js'

const DOTS_PER_LINE = 576
export const PRINT_WIDTH_DOTS = DOTS_PER_LINE

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

/**
 * Scale any drawable (a decoded image or a raster page rendered onto a Canvas)
 * to the printer width, Floyd–Steinberg dither it and emit ESC/POS raster
 * (`GS v 0`) chunks.
 */
function drawableToEscPos(source: Image | Canvas, srcWidth: number, srcHeight: number): Buffer[] {
  const printWidth = DOTS_PER_LINE
  const scale = printWidth / srcWidth
  const printHeight = Math.max(1, Math.round(srcHeight * scale))

  const canvas = new Canvas(printWidth, printHeight)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0, printWidth, printHeight)
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

async function imageToEscPos(imageBuffer: Buffer): Promise<Buffer[]> {
  const img = await loadImage(imageBuffer)
  return drawableToEscPos(img, img.width, img.height)
}

function rasterPageToEscPos(page: RasterPage): Buffer[] {
  const canvas = new Canvas(page.width, page.height)
  const ctx = canvas.getContext('2d')
  ctx.putImageData(new ImageData(page.rgba, page.width, page.height), 0, 0)
  return drawableToEscPos(canvas, page.width, page.height)
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
    socket.setTimeout(10_000)
    socket.on('timeout', () => {
      socket.destroy(new Error(`Tiskárna ${host} nereaguje (timeout 10 s)`))
    })
    socket.on('error', reject)
  })
}

const PRINTER_PORT = 9100
const INIT = Buffer.from([0x1b, 0x40]) // Initialize printer
const CENTER_ALIGN = Buffer.from([0x1b, 0x61, 1]) // Center alignment
const FEED = Buffer.from([0x1b, 0x64, 6]) // Feed 6 lines before cut
const CUT = Buffer.from([0x1b, 0x69]) // Full cut

/** Wrap already-rendered ESC/POS raster chunks with init/cut and send `copies` times. */
async function sendCopies(host: string, chunks: Buffer[], copies: number): Promise<void> {
  const payload: Buffer[] = [INIT, CENTER_ALIGN]
  for (let i = 0; i < copies; i++) {
    payload.push(...chunks, FEED, CUT)
  }
  await socketWrite(host, PRINTER_PORT, payload)
}

export async function printImage(host: string, imageBuffer: Buffer, copies: number): Promise<void> {
  await sendCopies(host, await imageToEscPos(imageBuffer), copies)
}

/**
 * Print decoded raster pages (from a driverless IPP job). All pages are rendered
 * back-to-back and the whole document is cut once per copy.
 */
export async function printRasterPages(host: string, pages: RasterPage[], copies: number): Promise<void> {
  const chunks: Buffer[] = []
  for (const page of pages) {
    chunks.push(...rasterPageToEscPos(page))
  }
  await sendCopies(host, chunks, copies)
}
