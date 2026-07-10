import { Canvas } from 'skia-canvas'
import { describe, expect, it } from 'vitest'
import { renderPdfToPages } from '../src/ipp/pdf.js'

/** Produce a small one-page PDF with a black rectangle via skia-canvas. */
async function makePdf(): Promise<Buffer> {
	const canvas = new Canvas(240, 120)
	const ctx = canvas.getContext('2d')
	ctx.fillStyle = 'white'
	ctx.fillRect(0, 0, 240, 120)
	ctx.fillStyle = 'black'
	ctx.fillRect(20, 20, 200, 40)
	return canvas.toBuffer('pdf')
}

describe('PDF rendering', () => {
	it('rasterizes a PDF to the target width with dark content', async () => {
		const pdf = await makePdf()
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

		const pages = await renderPdfToPages(pdf, 576)
		expect(pages).toHaveLength(1)
		expect(pages[0].width).toBe(576)
		expect(pages[0].height).toBeGreaterThan(0)

		let dark = 0
		for (let i = 0; i < pages[0].rgba.length; i += 4) if (pages[0].rgba[i] < 40) dark++
		expect(dark).toBeGreaterThan(1000)
	})

	it('honors a narrower (58 mm) target width', async () => {
		const pages = await renderPdfToPages(await makePdf(), 384)
		expect(pages[0].width).toBe(384)
	})
})
