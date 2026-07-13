import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Canvas } from 'skia-canvas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DitherAlgorithm } from '../src/config.js'

let printer: typeof import('../src/printer.js')
let config: typeof import('../src/config.js')

beforeAll(async () => {
	process.env.THERMAL_CONFIG_PATH = join(tmpdir(), `printer-test-${Math.random().toString(36).slice(2)}.json`)
	config = await import('../src/config.js')
	printer = await import('../src/printer.js')
})

function solid(value: number, width = 8, height = 1): Uint8ClampedArray {
	const rgba = new Uint8ClampedArray(width * height * 4)
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = value
		rgba[i * 4 + 3] = 255
	}
	return rgba
}

describe('halftone', () => {
	const algorithms: DitherAlgorithm[] = ['floyd', 'atkinson', 'ordered', 'threshold']

	for (const algorithm of algorithms) {
		it(`${algorithm}: solid black → all bits set, solid white → none`, () => {
			const opts = { algorithm, brightness: 0, contrast: 0 }
			expect(printer.halftone(solid(0), 8, 1, opts)[0]).toBe(0xff)
			expect(printer.halftone(solid(255), 8, 1, opts)[0]).toBe(0x00)
		})
	}

	it('brightness pushes mid-gray to white or black', () => {
		const gray = solid(128)
		expect(printer.halftone(gray, 8, 1, { algorithm: 'threshold', brightness: 100, contrast: 0 })[0]).toBe(0x00)
		expect(printer.halftone(gray, 8, 1, { algorithm: 'threshold', brightness: -100, contrast: 0 })[0]).toBe(0xff)
	})
})

describe('printImage / printRasterPages', () => {
	async function pngWithBlackBox(): Promise<Buffer> {
		const canvas = new Canvas(100, 50)
		const ctx = canvas.getContext('2d')
		ctx.fillStyle = 'white'
		ctx.fillRect(0, 0, 100, 50)
		ctx.fillStyle = 'black'
		ctx.fillRect(10, 10, 80, 30)
		return canvas.toBuffer('png')
	}

	async function capture(run: () => Promise<void>): Promise<Buffer> {
		const chunks: Buffer[] = []
		const server = net.createServer((s) => s.on('data', (d) => chunks.push(d)))
		await new Promise<void>((r) => server.listen(9100, '127.0.0.1', r))
		try {
			await run()
		} finally {
			server.close()
		}
		return Buffer.concat(chunks)
	}

	const countCuts = (b: Buffer) => {
		let n = 0
		for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x1b && b[i + 1] === 0x69) n++
		return n
	}

	it('emits GS v 0 raster at the configured width and one cut per copy', async () => {
		config.setConfig({ paperWidthDots: 576, ditherAlgorithm: 'floyd', brightness: 0, contrast: 0 })
		const png = await pngWithBlackBox()
		const buf = await capture(() => printer.printImage('127.0.0.1', png, 2))

		expect(buf[0]).toBe(0x1b) // ESC @
		expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(true) // GS v 0
		// bytesPerRow for 576 dots = 72 → xL=72, xH=0 in the first raster header.
		const gsIdx = buf.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]))
		expect(buf[gsIdx + 4]).toBe(72)
		expect(buf[gsIdx + 5]).toBe(0)
		expect(countCuts(buf)).toBe(2)
	})

	it('respects a 58 mm width (384 dots → 48 bytes/row)', async () => {
		config.setConfig({ paperWidthDots: 384 })
		const png = await pngWithBlackBox()
		const buf = await capture(() => printer.printImage('127.0.0.1', png, 1))
		const gsIdx = buf.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]))
		expect(buf[gsIdx + 4]).toBe(48)
	})

	// A raster page with a black rectangle drawn into the given content box.
	function rasterWithBox(width: number, height: number, box: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
		const rgba = new Uint8ClampedArray(width * height * 4).fill(255)
		for (let y = box.y; y < box.y + box.h; y++) {
			for (let x = box.x; x < box.x + box.w; x++) {
				const i = (y * width + x) * 4
				rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
				rgba[i + 3] = 255
			}
		}
		return rgba
	}

	it('prints raster pages', async () => {
		config.setConfig({ paperWidthDots: 576 })
		const rgba = rasterWithBox(120, 40, { x: 10, y: 5, w: 100, h: 30 })
		const buf = await capture(() => printer.printRasterPages('127.0.0.1', [{ width: 120, height: 40, rgba }], 1))
		expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(true)
		expect(countCuts(buf)).toBe(1)
	})

	it('skips a fully blank raster page (no raster, no wasted paper)', async () => {
		config.setConfig({ paperWidthDots: 576 })
		const rgba = new Uint8ClampedArray(120 * 40 * 4).fill(255)
		const buf = await capture(() => printer.printRasterPages('127.0.0.1', [{ width: 120, height: 40, rgba }], 1))
		expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(false)
	})
})

describe('cropRasterToContent', () => {
	function rasterWithBox(width: number, height: number, box: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
		const rgba = new Uint8ClampedArray(width * height * 4).fill(255)
		for (let y = box.y; y < box.y + box.h; y++) {
			for (let x = box.x; x < box.x + box.w; x++) {
				const i = (y * width + x) * 4
				rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
			}
		}
		return rgba
	}

	it('crops away blank margins (with an 8px padding) around the content', () => {
		// 400×2000 page, content is a 40×40 box far from the edges.
		const rgba = rasterWithBox(400, 2000, { x: 100, y: 900, w: 40, h: 40 })
		const cropped = printer.cropRasterToContent({ width: 400, height: 2000, rgba })
		expect(cropped).not.toBeNull()
		// 40px content + 8px padding on each side = 56.
		expect(cropped?.width).toBe(56)
		expect(cropped?.height).toBe(56)
	})

	it('returns null for a fully blank page', () => {
		const rgba = new Uint8ClampedArray(50 * 50 * 4).fill(255)
		expect(printer.cropRasterToContent({ width: 50, height: 50, rgba })).toBeNull()
	})

	it('leaves an already-tight page unchanged', () => {
		const rgba = rasterWithBox(30, 30, { x: 0, y: 0, w: 30, h: 30 })
		const page = { width: 30, height: 30, rgba }
		expect(printer.cropRasterToContent(page)).toBe(page)
	})

	it('clamps padding at the page edges', () => {
		// Content touches the top-left corner; padding can't go negative.
		const rgba = rasterWithBox(200, 200, { x: 0, y: 0, w: 10, h: 10 })
		const cropped = printer.cropRasterToContent({ width: 200, height: 200, rgba })
		// 10px content + 8px padding on the far side only (near side clamped at 0) = 18.
		expect(cropped?.width).toBe(18)
		expect(cropped?.height).toBe(18)
	})
})

describe('job preview', () => {
	const isPng = (b?: Buffer) => !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

	function rasterWithBox(width: number, height: number, box: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
		const rgba = new Uint8ClampedArray(width * height * 4).fill(255)
		for (let y = box.y; y < box.y + box.h; y++) {
			for (let x = box.x; x < box.x + box.w; x++) {
				const i = (y * width + x) * 4
				rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
			}
		}
		return rgba
	}

	it('buildRasterJob returns a PNG preview for a page with content', async () => {
		config.setConfig({ paperWidthDots: 576 })
		const rgba = rasterWithBox(300, 400, { x: 50, y: 50, w: 200, h: 200 })
		const { payload, preview } = await printer.buildRasterJob([{ width: 300, height: 400, rgba }], 1)
		expect(payload.length).toBeGreaterThan(0)
		expect(isPng(preview)).toBe(true)
	})

	it('buildRasterJob yields no preview for a fully blank page', async () => {
		const rgba = new Uint8ClampedArray(300 * 400 * 4).fill(255)
		const { preview } = await printer.buildRasterJob([{ width: 300, height: 400, rgba }], 1)
		expect(preview).toBeUndefined()
	})
})

describe('cut mode + cash drawer', () => {
	const FULL = Buffer.from([0x1b, 0x69])
	const PARTIAL = Buffer.from([0x1b, 0x6d])

	it('emits the cut command for the configured mode', () => {
		config.setConfig({ cutMode: 'full' })
		let p = printer.buildTestPayload('N', '1.2.3.4')
		expect(p.includes(FULL)).toBe(true)

		config.setConfig({ cutMode: 'partial' })
		p = printer.buildTestPayload('N', '1.2.3.4')
		expect(p.includes(PARTIAL)).toBe(true)
		expect(p.includes(FULL)).toBe(false)

		config.setConfig({ cutMode: 'none' })
		p = printer.buildTestPayload('N', '1.2.3.4')
		expect(p.includes(FULL)).toBe(false)
		expect(p.includes(PARTIAL)).toBe(false)

		config.setConfig({ cutMode: 'full' }) // restore
	})

	it('sends the cash-drawer pulse to the printer port', async () => {
		const chunks: Buffer[] = []
		const server = net.createServer((s) => s.on('data', (d) => chunks.push(d)))
		await new Promise<void>((r) => server.listen(9100, '127.0.0.1', r))
		try {
			await printer.openCashDrawer('127.0.0.1')
		} finally {
			server.close()
		}
		expect(Buffer.concat(chunks).equals(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(true)
	})
})

afterAll(() => {
	/* config temp file left in tmpdir */
})
