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

/** A dithered 1-bit-per-pixel bitmap at the printer width (bit set = black dot). */
interface Bitmap {
  bits: Uint8Array
  width: number
  height: number
}

/**
 * Scale any drawable (a decoded image or a raster page rendered onto a Canvas)
 * to the printer width and Floyd–Steinberg dither it to the 1-bit bitmap that is
 * both sent to the printer and rendered as the job's preview.
 */
function drawableToBitmap(source: Image | Canvas, srcWidth: number, srcHeight: number): Bitmap {
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
  return { bits, width: printWidth, height: printHeight }
}

/** Emit ESC/POS raster (`GS v 0`) chunks for a dithered bitmap. */
function bitmapToEscPos(bm: Bitmap): Buffer[] {
  const bytesPerRow = Math.ceil(bm.width / 8)
  const chunkHeight = 1024
  const buffers: Buffer[] = []

  for (let y = 0; y < bm.height; y += chunkHeight) {
    const h = Math.min(chunkHeight, bm.height - y)
    const xL = bytesPerRow & 0xff
    const xH = (bytesPerRow >> 8) & 0xff
    const yL = h & 0xff
    const yH = (h >> 8) & 0xff

    const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH])
    const data = Buffer.from(bm.bits.slice(y * bytesPerRow, (y + h) * bytesPerRow))
    buffers.push(header, data)
  }

  return buffers
}

function drawableToEscPos(source: Image | Canvas, srcWidth: number, srcHeight: number): Buffer[] {
  return bitmapToEscPos(drawableToBitmap(source, srcWidth, srcHeight))
}

/**
 * Stitch the job's dithered bitmaps vertically into a single monochrome PNG —
 * a faithful "what was printed" preview for the print history.
 */
async function bitmapsToPreviewPng(bitmaps: Bitmap[]): Promise<Buffer | undefined> {
  const totalHeight = bitmaps.reduce((sum, b) => sum + b.height, 0)
  if (!totalHeight) return undefined
  const width = Math.max(...bitmaps.map((b) => b.width))

  const canvas = new Canvas(width, totalHeight)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, totalHeight)

  let offsetY = 0
  for (const bm of bitmaps) {
    const img = ctx.createImageData(bm.width, bm.height)
    const bytesPerRow = Math.ceil(bm.width / 8)
    for (let y = 0; y < bm.height; y++) {
      for (let x = 0; x < bm.width; x++) {
        const bit = (bm.bits[y * bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1
        const di = (y * bm.width + x) * 4
        const v = bit ? 0 : 255 // bit set = black dot
        img.data[di] = img.data[di + 1] = img.data[di + 2] = v
        img.data[di + 3] = 255
      }
    }
    ctx.putImageData(img, 0, offsetY)
    offsetY += bm.height
  }
  return await canvas.toBuffer('png')
}

async function imageToEscPos(imageBuffer: Buffer): Promise<Buffer[]> {
  const img = await loadImage(imageBuffer)
  return drawableToEscPos(img, img.width, img.height)
}

/**
 * The OS rasterises a system-print job onto a fixed-size page (e.g. A4-tall),
 * so a small image arrives centred in a sea of blank margins. On a continuous
 * thermal roll that empty space is just wasted paper — and, scaled to width,
 * shrinks the actual content. Crop to the content's bounding box so we feed
 * only the paper the content needs and it fills the roll width.
 * Returns null when the page is entirely blank (nothing to print).
 */
export function cropRasterToContent(page: RasterPage): RasterPage | null {
  const { width, height, rgba } = page
  // A pixel is "ink" when it is visibly darker than the (white) paper.
  const isInk = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4
    const luma = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114
    return luma < 250
  }

  let top = -1
  let bottom = -1
  let left = width
  let right = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInk(x, y)) continue
      if (top === -1) top = y
      bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (top === -1) return null // fully blank page

  // Leave a little breathing room so content isn't shaved to the edge.
  const pad = 8
  top = Math.max(0, top - pad)
  bottom = Math.min(height - 1, bottom + pad)
  left = Math.max(0, left - pad)
  right = Math.min(width - 1, right + pad)

  const cw = right - left + 1
  const ch = bottom - top + 1
  if (cw === width && ch === height) return page // already tight

  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const srcStart = ((top + y) * width + left) * 4
    out.set(rgba.subarray(srcStart, srcStart + cw * 4), y * cw * 4)
  }
  return { width: cw, height: ch, rgba: out }
}

/** Crop a raster page to its content and dither it; null for a blank page. */
function rasterPageToBitmap(page: RasterPage): Bitmap | null {
  const cropped = cropRasterToContent(page)
  if (!cropped) return null // blank page — print nothing, waste no paper
  const canvas = new Canvas(cropped.width, cropped.height)
  const ctx = canvas.getContext('2d')
  ctx.putImageData(new ImageData(cropped.rgba, cropped.width, cropped.height), 0, 0)
  return drawableToBitmap(canvas, cropped.width, cropped.height)
}

const DEFAULT_PORT = 9100
const INIT = Buffer.from([0x1b, 0x40]) // Initialize printer
const CENTER_ALIGN = Buffer.from([0x1b, 0x61, 1]) // Center alignment
const FEED = Buffer.from([0x1b, 0x64, 6]) // Feed 6 lines before cut

/** Cut command per the configured cut mode (empty buffer = no cut). */
function cutBytes(): Buffer {
  switch (getConfig().cutMode) {
    case 'none':
      return Buffer.alloc(0)
    case 'partial':
      return Buffer.from([0x1b, 0x6d]) // ESC m — partial cut
    default:
      return Buffer.from([0x1b, 0x69]) // ESC i — full cut
  }
}

/** Open a raw-print connection and write a fully-assembled ESC/POS payload. */
export function sendEscPos(host: string, payload: Buffer, port = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
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

/** Pulse the cash drawer connected to the printer (ESC p 0 25ms 250ms). */
export function openCashDrawer(host: string, port = DEFAULT_PORT): Promise<void> {
  return sendEscPos(host, Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]), port)
}

/** Wrap already-rendered ESC/POS raster chunks with init/cut, `copies` times. */
function assembleCopies(chunks: Buffer[], copies: number): Buffer {
  const cut = cutBytes()
  const parts: Buffer[] = [INIT, CENTER_ALIGN]
  for (let i = 0; i < copies; i++) parts.push(...chunks, FEED, cut)
  return Buffer.concat(parts)
}

/** Build the ESC/POS payload for one image (assembled, ready to send). */
async function buildImagePayload(imageBuffer: Buffer, copies: number): Promise<Buffer> {
  return assembleCopies(await imageToEscPos(imageBuffer), copies)
}

/** An assembled ESC/POS payload plus a monochrome PNG preview of what it prints. */
export interface PrintBuild {
  payload: Buffer
  preview?: Buffer
}

/** Build several images back-to-back (each cut), shared init, with a preview. */
export async function buildImagesJob(imageBuffers: Buffer[], copies: number): Promise<PrintBuild> {
  const cut = cutBytes()
  const bitmaps: Bitmap[] = []
  const chunks: Buffer[] = []
  for (const buf of imageBuffers) {
    const img = await loadImage(buf)
    const bm = drawableToBitmap(img, img.width, img.height)
    bitmaps.push(bm)
    chunks.push(...bitmapToEscPos(bm), FEED, cut)
  }
  // Re-use the shared INIT/CENTER, but the per-image feed/cut are already
  // included, so repeat the chunk block once per copy.
  const parts: Buffer[] = [INIT, CENTER_ALIGN]
  for (let i = 0; i < copies; i++) parts.push(...chunks)
  return { payload: Buffer.concat(parts), preview: await bitmapsToPreviewPng(bitmaps) }
}

/** Build decoded raster pages (from an IPP job) into a payload, with a preview. */
export async function buildRasterJob(pages: RasterPage[], copies: number): Promise<PrintBuild> {
  const bitmaps: Bitmap[] = []
  const chunks: Buffer[] = []
  for (const page of pages) {
    const bm = rasterPageToBitmap(page)
    if (!bm) continue // blank page — skip
    bitmaps.push(bm)
    chunks.push(...bitmapToEscPos(bm))
  }
  return { payload: assembleCopies(chunks, copies), preview: await bitmapsToPreviewPng(bitmaps) }
}

/** Build the ESC/POS payload for decoded raster pages (from an IPP job). */
export async function buildRasterPayload(pages: RasterPage[], copies: number): Promise<Buffer> {
  return (await buildRasterJob(pages, copies)).payload
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
    cutBytes(),
  ])
}

// Convenience wrappers (build + send). Used by tests and simple call sites.
export async function printImage(host: string, imageBuffer: Buffer, copies: number): Promise<void> {
  await sendEscPos(host, await buildImagePayload(imageBuffer, copies))
}

export async function printRasterPages(host: string, pages: RasterPage[], copies: number): Promise<void> {
  await sendEscPos(host, await buildRasterPayload(pages, copies))
}
