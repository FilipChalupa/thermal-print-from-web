/**
 * Render a PDF (some OSes send application/pdf over IPP instead of raster) into
 * RGBA pages at the target print width, so it can go through the same
 * dither → ESC/POS path as everything else. Uses MuPDF (WASM) for rendering.
 */
import * as mupdf from 'mupdf'
import type { RasterPage } from './pwg-raster.js'

export async function renderPdfToPages(pdf: Buffer, widthDots: number): Promise<RasterPage[]> {
	const doc = mupdf.Document.openDocument(pdf, 'application/pdf')
	const pages: RasterPage[] = []

	const count = doc.countPages()
	for (let i = 0; i < count; i++) {
		const page = doc.loadPage(i)
		const bounds = page.getBounds() // [x0, y0, x1, y1] in points (72 dpi)
		const widthPts = bounds[2] - bounds[0]
		const scale = widthPts > 0 ? widthDots / widthPts : 1

		// alpha = false renders onto a white background (blank areas stay white).
		const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
		const width = pixmap.getWidth()
		const height = pixmap.getHeight()
		const components = pixmap.getNumberOfComponents() // 3 for DeviceRGB w/o alpha
		const src = pixmap.getPixels()

		const rgba = new Uint8ClampedArray(width * height * 4)
		for (let p = 0; p < width * height; p++) {
			rgba[p * 4] = src[p * components]
			rgba[p * 4 + 1] = src[p * components + 1]
			rgba[p * 4 + 2] = src[p * components + 2]
			rgba[p * 4 + 3] = 255
		}
		pages.push({ width, height, rgba })
	}

	return pages
}
