import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { attr, decode, encode, findAttr, GroupTag, ValueTag } from '../src/ipp/encoding.js'
import type { IppMessage, IppValue } from '../src/ipp/encoding.js'

let server: typeof import('../src/ipp/server.js')

beforeAll(async () => {
	process.env.THERMAL_CONFIG_PATH = join(tmpdir(), `ipp-media-${Math.random().toString(36).slice(2)}.json`)
	server = await import('../src/ipp/server.js')
})

function getPrinterAttributes(): IppMessage {
	const req: IppMessage = {
		versionMajor: 1,
		versionMinor: 1,
		code: 0x000b, // Get-Printer-Attributes
		requestId: 1,
		groups: [
			{
				tag: GroupTag.operation,
				attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')],
			},
		],
		data: Buffer.alloc(0),
	}
	return req
}

describe('IPP media: variable-length roll', () => {
	it('advertises the media y-dimension as a range (continuous roll)', async () => {
		const ctx = {
			printerUri: 'ipp://127.0.0.1:6310/ipp/print',
			printer: { name: 'Test', uuid: 'u', targetIp: '127.0.0.1', targetPort: 9100, resourcePath: 'ipp/print', primary: true },
		}
		const res = decode(await server.handleIppRequest(encode(getPrinterAttributes()), ctx))

		// media-col-database → media-size → y-dimension must be a rangeOfInteger.
		const mediaCol = findAttr(res, GroupTag.printer, 'media-col-database')?.value as Record<string, IppValue[]>
		expect(mediaCol).toBeTruthy()
		const size = mediaCol['media-size'][0].value as Record<string, IppValue[]>
		const y = size['y-dimension'][0]
		expect(y.tag).toBe(ValueTag.rangeOfInteger)
		expect(y.value).toMatchObject({ lower: expect.any(Number), upper: expect.any(Number) })
		const range = y.value as { lower: number; upper: number }
		expect(range.upper).toBeGreaterThan(range.lower)
		// x-dimension (roll width) stays a fixed integer.
		expect(size['x-dimension'][0].tag).toBe(ValueTag.integer)
	})
})
