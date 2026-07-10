import { describe, expect, it } from 'vitest'
import { decodeRaster } from '../src/ipp/pwg-raster.js'

const W = 300
const H = 150

/** White background with a black rectangle in the middle. */
function testImage(): Uint8ClampedArray {
	const rgba = new Uint8ClampedArray(W * H * 4).fill(255)
	for (let y = 30; y < 120; y++)
		for (let x = 50; x < 250; x++) {
			const o = (y * W + x) * 4
			rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
		}
	return rgba
}

/** Encode a row group with the PWG/URF modified-PackBits (literal runs). */
function encodeRows(rgba: Uint8ClampedArray, width: number, height: number): Buffer[] {
	const rows: Buffer[] = []
	for (let y = 0; y < height; y++) {
		rows.push(Buffer.from([0])) // line repeat: 1 copy
		let x = 0
		while (x < width) {
			const n = Math.min(128, width - x)
			rows.push(Buffer.from([257 - n])) // literal control byte
			const pix = Buffer.alloc(n * 3)
			for (let i = 0; i < n; i++) {
				const o = (y * width + (x + i)) * 4
				pix[i * 3] = rgba[o]
				pix[i * 3 + 1] = rgba[o + 1]
				pix[i * 3 + 2] = rgba[o + 2]
			}
			rows.push(pix)
			x += n
		}
	}
	return rows
}

function buildPwg(rgba: Uint8ClampedArray): Buffer {
	const header = Buffer.alloc(1796)
	header.write('PwgRaster', 0, 'latin1')
	header.writeUInt32BE(203, 276)
	header.writeUInt32BE(203, 280)
	header.writeUInt32BE(W, 372)
	header.writeUInt32BE(H, 376)
	header.writeUInt32BE(8, 384)
	header.writeUInt32BE(24, 388)
	header.writeUInt32BE(W * 3, 392)
	header.writeUInt32BE(19, 400) // sRGB
	header.writeUInt32BE(3, 420)
	return Buffer.concat([Buffer.from('RaS2', 'latin1'), header, ...encodeRows(rgba, W, H)])
}

function buildUrf(rgba: Uint8ClampedArray): Buffer {
	const magic = Buffer.from('UNIRAST\0', 'latin1')
	const pageCount = Buffer.alloc(4)
	pageCount.writeUInt32BE(1)
	const h = Buffer.alloc(32)
	h[0] = 24 // bits per pixel
	h[1] = 1 // colorspace index 1 = SRGB
	h.writeUInt32BE(W, 12)
	h.writeUInt32BE(H, 16)
	h.writeUInt32BE(203, 20)
	return Buffer.concat([magic, pageCount, h, ...encodeRows(rgba, W, H)])
}

describe('raster decoding', () => {
	for (const [name, build] of [
		['PWG Raster', buildPwg],
		['Apple URF', buildUrf],
	] as const) {
		it(`decodes ${name} geometry and pixels`, () => {
			const pages = decodeRaster(build(testImage()))
			expect(pages).toHaveLength(1)
			expect(pages[0].width).toBe(W)
			expect(pages[0].height).toBe(H)
			const px = (x: number, y: number) => pages[0].rgba[(y * W + x) * 4]
			expect(px(0, 0)).toBeGreaterThan(200) // corner white
			expect(px(150, 75)).toBeLessThan(50) // centre black
		})
	}

	it('throws on an unknown format', () => {
		expect(() => decodeRaster(Buffer.from('NOPE....'))).toThrow()
	})
})
