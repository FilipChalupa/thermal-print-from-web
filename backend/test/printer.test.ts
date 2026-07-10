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

	it('prints raster pages', async () => {
		config.setConfig({ paperWidthDots: 576 })
		const rgba = new Uint8ClampedArray(120 * 40 * 4).fill(255)
		const buf = await capture(() => printer.printRasterPages('127.0.0.1', [{ width: 120, height: 40, rgba }], 1))
		expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(true)
		expect(countCuts(buf)).toBe(1)
	})
})

afterAll(() => {
	/* config temp file left in tmpdir */
})
