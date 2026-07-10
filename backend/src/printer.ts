import { Canvas, Image, ImageData, loadImage } from 'skia-canvas'
import iconv from 'iconv-lite'
import * as net from 'net'
import { getConfig } from './config.js'
import type { DitherAlgorithm } from './config.js'
import type { RasterPage } from './ipp/pwg-raster.js'

const DOTS_PER_LINE = 576

/** Configured print width in dots (576 = 80 mm, 384 = 58 mm), rounded to a byte. */
function printWidthDots(): number {
  const dots = getConfig().paperWidthDots || DOTS_PER_LINE
  return Math.max(8, Math.round(dots / 8) * 8)
}

export interface HalftoneOptions {
  algorithm: DitherAlgorithm
  brightness: number // -100…100
  contrast: number // -100…100
}

// Normalized 8×8 Bayer matrix for ordered dithering.
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

/**
 * Convert RGBA image data to packed 1-bit (1 = black), applying brightness /
 * contrast and the chosen halftoning algorithm.
 */
export function halftone(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  opts: HalftoneOptions,
): Uint8Array {
  const pixels = new Float32Array(width * height)

  // Grayscale luminance with brightness / contrast pre-adjustment.
  const bAdd = opts.brightness * 1.28
  const c = Math.max(-255, Math.min(255, opts.contrast * 2.55))
  const cf = (259 * (c + 255)) / (255 * (259 - c))
  for (let i = 0; i < width * height; i++) {
    const lum = 0.299 * imageData[i * 4] + 0.587 * imageData[i * 4 + 1] + 0.114 * imageData[i * 4 + 2]
    pixels[i] = Math.max(0, Math.min(255, cf * (lum + bAdd - 128) + 128))
  }

  if (opts.algorithm === 'threshold' || opts.algorithm === 'ordered') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        const threshold = opts.algorithm === 'ordered' ? ((BAYER_8[y & 7][x & 7] + 0.5) / 64) * 255 : 128
        pixels[idx] = pixels[idx] < threshold ? 0 : 255
      }
    }
  } else {
    // Error-diffusion (Floyd–Steinberg or Atkinson).
    const atkinson = opts.algorithm === 'atkinson'
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        const old = pixels[idx]
        const newVal = old < 128 ? 0 : 255
        pixels[idx] = newVal
        const err = old - newVal
        const add = (dx: number, dy: number, num: number, den: number) => {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny >= height) return
          pixels[ny * width + nx] += (err * num) / den
        }
        if (atkinson) {
          add(1, 0, 1, 8)
          add(2, 0, 1, 8)
          add(-1, 1, 1, 8)
          add(0, 1, 1, 8)
          add(1, 1, 1, 8)
          add(0, 2, 1, 8)
        } else {
          add(1, 0, 7, 16)
          add(-1, 1, 3, 16)
          add(0, 1, 5, 16)
          add(1, 1, 1, 16)
        }
      }
    }
  }

  // Pack to 1-bit per pixel (black = set bit).
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
  const printWidth = printWidthDots()
  const scale = printWidth / srcWidth
  const printHeight = Math.max(1, Math.round(srcHeight * scale))

  const canvas = new Canvas(printWidth, printHeight)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0, printWidth, printHeight)
  const imageData = ctx.getImageData(0, 0, printWidth, printHeight)

  const cfg = getConfig()
  const bits = halftone(imageData.data as Uint8ClampedArray, printWidth, printHeight, {
    algorithm: cfg.ditherAlgorithm,
    brightness: cfg.brightness,
    contrast: cfg.contrast,
  })
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

export const PRINTER_PORT = 9100
const INIT = Buffer.from([0x1b, 0x40]) // Initialize printer
const CENTER_ALIGN = Buffer.from([0x1b, 0x61, 1]) // Center alignment
const FEED = Buffer.from([0x1b, 0x64, 6]) // Feed 6 lines before cut
const CUT = Buffer.from([0x1b, 0x69]) // Full cut

/** Open a raw-print connection and write a fully-assembled ESC/POS payload. */
export function sendEscPos(host: string, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: PRINTER_PORT }, () => {
      socket.write(payload)
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

/** Wrap already-rendered ESC/POS raster chunks with init/cut, `copies` times. */
function assembleCopies(chunks: Buffer[], copies: number): Buffer {
  const parts: Buffer[] = [INIT, CENTER_ALIGN]
  for (let i = 0; i < copies; i++) parts.push(...chunks, FEED, CUT)
  return Buffer.concat(parts)
}

/** Build the ESC/POS payload for one image (assembled, ready to send). */
export async function buildImagePayload(imageBuffer: Buffer, copies: number): Promise<Buffer> {
  return assembleCopies(await imageToEscPos(imageBuffer), copies)
}

/** Build a payload from several images back-to-back (each cut), shared init. */
export async function buildImagesPayload(imageBuffers: Buffer[], copies: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (const buf of imageBuffers) chunks.push(...(await imageToEscPos(buf)), FEED, CUT)
  // Re-use assembleCopies for the shared INIT/CENTER, but the per-image feed/cut
  // are already included, so pass the chunks as a single "copy" and repeat that.
  const parts: Buffer[] = [INIT, CENTER_ALIGN]
  for (let i = 0; i < copies; i++) parts.push(...chunks)
  return Buffer.concat(parts)
}

/** Build the ESC/POS payload for decoded raster pages (from an IPP job). */
export async function buildRasterPayload(pages: RasterPage[], copies: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (const page of pages) chunks.push(...rasterPageToEscPos(page))
  return assembleCopies(chunks, copies)
}

/**
 * Build a small text test receipt (printer name + IP + timestamp) so the user can
 * confirm a discovered device is really the intended thermal printer. Text is
 * encoded as CP852 for Czech characters.
 */
export function buildTestPayload(name: string, ip: string, at = new Date()): Buffer {
  const cp852 = (s: string) => iconv.encode(s, 'CP852')
  const DOUBLE = Buffer.from([0x1b, 0x21, 0x30]) // ESC ! — double width + height
  const NORMAL = Buffer.from([0x1b, 0x21, 0x00])
  const BOLD_ON = Buffer.from([0x1b, 0x45, 1])
  const BOLD_OFF = Buffer.from([0x1b, 0x45, 0])
  const NL = Buffer.from([0x0a])

  return Buffer.concat([
    INIT,
    CENTER_ALIGN,
    DOUBLE,
    cp852('TEST'),
    NL,
    NORMAL,
    NL,
    BOLD_ON,
    cp852(name),
    BOLD_OFF,
    NL,
    cp852(ip),
    NL,
    cp852(at.toLocaleString('cs-CZ')),
    NL,
    FEED,
    CUT,
  ])
}

// Convenience wrappers (build + send). Used by tests and simple call sites.
export async function printImage(host: string, imageBuffer: Buffer, copies: number): Promise<void> {
  await sendEscPos(host, await buildImagePayload(imageBuffer, copies))
}

export async function printRasterPages(host: string, pages: RasterPage[], copies: number): Promise<void> {
  await sendEscPos(host, await buildRasterPayload(pages, copies))
}
