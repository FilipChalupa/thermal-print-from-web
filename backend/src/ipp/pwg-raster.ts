/**
 * Decoder for the two raster formats a driverless OS sends over IPP:
 *   - PWG Raster (image/pwg-raster) — 4-byte "RaS2" sync, per-page 1796-byte header
 *   - Apple Raster / URF (image/urf) — "UNIRAST\0" magic, per-page 32-byte header
 *
 * Both carry the page bitmap using the same modified-PackBits row encoding used
 * by CUPS (see cups/raster-stream.c `cupsRasterReadPixels`). We decode every page
 * to RGBA so it can be dropped straight onto a canvas for scaling + dithering.
 */

// CUPS colorspace codes we care about.
const CSPACE = {
	W: 0, // DeviceGray, additive (max = white)
	RGB: 1,
	K: 3, // Black, subtractive (max = black)
	CMY: 4,
	CMYK: 6,
	SW: 18, // sGray
	SRGB: 19,
	ADOBERGB: 20,
} as const

// Colorspaces where a fully-set byte means white (additive). Mirrors the list in
// cupsRasterReadPixels used to decide the "clear to end of line" fill value.
const WHITE_BASED = new Set<number>([CSPACE.W, CSPACE.RGB, CSPACE.SW, CSPACE.SRGB, CSPACE.ADOBERGB])

export interface RasterPage {
	width: number
	height: number
	/** RGBA, 4 bytes per pixel, row-major. Alpha is always 255. */
	rgba: Uint8ClampedArray
}

interface PageHeader {
	width: number
	height: number
	bitsPerColor: number
	bitsPerPixel: number
	bytesPerLine: number
	numColors: number
	colorSpace: number
}

class ByteReader {
	offset = 0
	constructor(readonly buf: Buffer) {}
	u8(): number {
		return this.buf[this.offset++]
	}
	u32be(): number {
		const v = this.buf.readUInt32BE(this.offset)
		this.offset += 4
		return v
	}
	take(n: number): Buffer {
		const v = this.buf.subarray(this.offset, this.offset + n)
		this.offset += n
		return v
	}
	get remaining(): number {
		return this.buf.length - this.offset
	}
}

/** Decode a whole document (possibly multiple pages) to RGBA pages. */
export function decodeRaster(buf: Buffer): RasterPage[] {
	if (buf.length < 4) throw new Error('Raster stream too short')
	const magic = buf.toString('latin1', 0, 4)

	if (magic === 'UNIR') {
		return decodeApple(buf)
	}
	// "RaS2" and its reverse "2SaR"; also tolerate the v2/v1 variants.
	if (magic === 'RaS2' || magic === '2SaR' || magic === 'RaSt' || magic === 'tSaR' || magic === 'RaS3' || magic === '3SaR') {
		const swapped = magic[0] !== 'R'
		return decodePwg(buf, swapped)
	}
	throw new Error(`Unknown raster format (magic ${JSON.stringify(magic)})`)
}

// --- Apple Raster / URF ------------------------------------------------------

// URF colorspace byte -> [cupsColorSpace, numColors], matching cups/raster-stream.c.
const URF_CSPACE: Array<[number, number]> = [
	[CSPACE.SW, 1],
	[CSPACE.SRGB, 3],
	[CSPACE.ADOBERGB, 3], // CIELab in CUPS; treated as 3-channel here
	[CSPACE.ADOBERGB, 3],
	[CSPACE.W, 1],
	[CSPACE.RGB, 3],
	[CSPACE.CMYK, 4],
]

function decodeApple(buf: Buffer): RasterPage[] {
	const r = new ByteReader(buf)
	r.take(4) // "UNIR"
	r.take(8) // "AST\0" + 4-byte page count
	const pages: RasterPage[] = []

	while (r.remaining >= 32) {
		const h = r.take(32)
		const bitsPerPixel = h[0]
		const cs = URF_CSPACE[h[1]] ?? [CSPACE.SRGB, 3]
		const colorSpace = cs[0]
		const numColors = cs[1]
		const bitsPerColor = Math.max(1, Math.floor(bitsPerPixel / numColors))
		const width = (h[12] << 24) | (h[13] << 16) | (h[14] << 8) | h[15]
		const height = (h[16] << 24) | (h[17] << 16) | (h[18] << 8) | h[19]
		const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8)

		const header: PageHeader = { width, height, bitsPerColor, bitsPerPixel, bytesPerLine, numColors, colorSpace }
		pages.push(decodePage(r, header))
	}
	return pages
}

// --- PWG Raster --------------------------------------------------------------

function decodePwg(buf: Buffer, swapped: boolean): RasterPage[] {
	const r = new ByteReader(buf)
	r.take(4) // sync word
	const u32 = (b: Buffer, off: number) => (swapped ? b.readUInt32LE(off) : b.readUInt32BE(off))
	const pages: RasterPage[] = []

	while (r.remaining >= 1796) {
		const h = r.take(1796)
		const width = u32(h, 372)
		const height = u32(h, 376)
		const bitsPerColor = u32(h, 384)
		const bitsPerPixel = u32(h, 388)
		const bytesPerLine = u32(h, 392)
		const colorSpace = u32(h, 400)
		let numColors = u32(h, 420)
		if (!numColors) numColors = Math.max(1, Math.round(bitsPerPixel / (bitsPerColor || 8)))

		const header: PageHeader = { width, height, bitsPerColor, bitsPerPixel, bytesPerLine, numColors, colorSpace }
		pages.push(decodePage(r, header))
	}
	return pages
}

// --- Shared page body (modified PackBits) ------------------------------------

function decodePage(r: ByteReader, h: PageHeader): RasterPage {
	const { width, height, bytesPerLine } = h
	const bpp = Math.max(1, Math.ceil(h.bitsPerPixel / 8)) // chunked color order
	const fill = WHITE_BASED.has(h.colorSpace) ? 0xff : 0x00
	const rgba = new Uint8ClampedArray(width * height * 4)

	let y = 0
	while (y < height && r.remaining > 0) {
		const repeat = r.u8() + 1
		const line = Buffer.alloc(bytesPerLine)
		let b = 0
		while (b < bytesPerLine && r.remaining > 0) {
			const ctrl = r.u8()
			if (ctrl === 128) {
				line.fill(fill, b)
				b = bytesPerLine
			} else if (ctrl & 128) {
				// literal run of (257 - ctrl) pixels
				let count = (257 - ctrl) * bpp
				if (count > bytesPerLine - b) count = bytesPerLine - b
				r.take(count).copy(line, b)
				b += count
			} else {
				// repeat next single pixel (ctrl + 1) times
				let count = (ctrl + 1) * bpp
				if (count > bytesPerLine - b) count = bytesPerLine - b
				const pixel = r.take(bpp)
				for (let i = 0; i < count; i += bpp) pixel.copy(line, b + i)
				b += count
			}
		}

		const rowRgba = lineToRgba(line, h)
		for (let rep = 0; rep < repeat && y < height; rep++, y++) {
			rgba.set(rowRgba, y * width * 4)
		}
	}

	return { width, height, rgba }
}

/** Convert one decoded scanline to a width*4 RGBA row. */
function lineToRgba(line: Buffer, h: PageHeader): Uint8ClampedArray {
	const { width, bitsPerColor, numColors, colorSpace } = h
	const out = new Uint8ClampedArray(width * 4)

	const setGray = (x: number, g: number) => {
		out[x * 4] = out[x * 4 + 1] = out[x * 4 + 2] = g
		out[x * 4 + 3] = 255
	}

	if (bitsPerColor === 1 && numColors === 1) {
		// 1 bit per pixel, MSB first.
		for (let x = 0; x < width; x++) {
			const bit = (line[x >> 3] >> (7 - (x & 7))) & 1
			// White-based: 1 = white. Black-based: 1 = black.
			const white = WHITE_BASED.has(colorSpace) ? bit === 1 : bit === 0
			setGray(x, white ? 255 : 0)
		}
		return out
	}

	// 8 bits per color (the common driverless case).
	const bytesPerPixel = numColors // at 8bpc
	for (let x = 0; x < width; x++) {
		const p = x * bytesPerPixel
		if (numColors >= 3 && (colorSpace === CSPACE.RGB || colorSpace === CSPACE.SRGB || colorSpace === CSPACE.ADOBERGB)) {
			const rr = line[p]
			const gg = line[p + 1]
			const bb = line[p + 2]
			setGray(x, 0.299 * rr + 0.587 * gg + 0.114 * bb)
		} else if (numColors === 4) {
			// CMYK ink amounts -> approximate RGB luminance.
			const c = line[p] / 255
			const m = line[p + 1] / 255
			const yl = line[p + 2] / 255
			const k = line[p + 3] / 255
			const rr = 255 * (1 - c) * (1 - k)
			const gg = 255 * (1 - m) * (1 - k)
			const bb = 255 * (1 - yl) * (1 - k)
			setGray(x, 0.299 * rr + 0.587 * gg + 0.114 * bb)
		} else {
			// Single channel gray. Additive colorspaces store white as max.
			const v = line[p]
			setGray(x, WHITE_BASED.has(colorSpace) ? v : 255 - v)
		}
	}
	return out
}
