import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attr, decode, encode, GroupTag } from '../src/ipp/encoding.js'
import type { IppMessage } from '../src/ipp/encoding.js'

// End-to-end for the driverless path: an IPP Print-Job carrying a PWG raster is
// decoded, converted to ESC/POS and delivered to the (fake) physical printer.

let server: typeof import('../src/ipp/server.js')

const W = 120
const H = 80
const FAKE_PORT = 9110

/** White page with a black rectangle in the middle. */
function testImage(): Uint8ClampedArray {
	const rgba = new Uint8ClampedArray(W * H * 4).fill(255)
	for (let y = 20; y < 60; y++)
		for (let x = 20; x < 100; x++) {
			const o = (y * W + x) * 4
			rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
		}
	return rgba
}

/** Encode rows with PWG/URF modified-PackBits (literal runs), 1 copy per line. */
function encodeRows(rgba: Uint8ClampedArray, width: number, height: number): Buffer[] {
	const rows: Buffer[] = []
	for (let y = 0; y < height; y++) {
		rows.push(Buffer.from([0]))
		let x = 0
		while (x < width) {
			const n = Math.min(128, width - x)
			rows.push(Buffer.from([257 - n]))
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

function printJob(doc: Buffer): IppMessage {
	return {
		versionMajor: 1,
		versionMinor: 1,
		code: 0x0002, // Print-Job
		requestId: 1,
		groups: [
			{
				tag: GroupTag.operation,
				attributes: [
					attr.charset('attributes-charset', 'utf-8'),
					attr.naturalLanguage('attributes-natural-language', 'en'),
					attr.uri('printer-uri', 'ipp://127.0.0.1:6310/ipp/print'),
					attr.name('job-name', 'raster-test'),
				],
			},
		],
		data: doc,
	}
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (cond()) return
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error('timed out waiting for condition')
}

describe('IPP Print-Job → ESC/POS delivery', () => {
	const received: Buffer[] = []
	let fake: net.Server

	beforeAll(async () => {
		process.env.THERMAL_CONFIG_PATH = join(tmpdir(), `ipp-print-${Math.random().toString(36).slice(2)}.json`)
		server = await import('../src/ipp/server.js')
		fake = net.createServer((s) => s.on('data', (d) => received.push(d)))
		await new Promise<void>((r) => fake.listen(FAKE_PORT, '127.0.0.1', r))
	})

	afterAll(() => {
		fake.close()
	})

	it('decodes a raster Print-Job and sends ESC/POS to the physical printer', async () => {
		const ctx = {
			printerUri: 'ipp://127.0.0.1:6310/ipp/print',
			printer: { name: 'T', uuid: 'u', targetIp: '127.0.0.1', targetPort: FAKE_PORT, resourcePath: 'ipp/print', primary: true },
		}
		const res = decode(await server.handleIppRequest(encode(printJob(buildPwg(testImage()))), ctx))
		expect(res.code).toBe(0x0000) // successful-ok

		// processJob runs asynchronously after the IPP reply; wait for delivery.
		await waitFor(() => received.length > 0, 5000)
		const buf = Buffer.concat(received)
		expect(buf[0]).toBe(0x1b) // ESC @ — printer init
		expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(true) // GS v 0 — raster
	})
})
