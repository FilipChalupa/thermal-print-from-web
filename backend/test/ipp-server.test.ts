import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { attr, decode, encode, GroupTag } from '../src/ipp/encoding.js'
import type { IppMessage } from '../src/ipp/encoding.js'

let server: typeof import('../src/ipp/server.js')
let config: typeof import('../src/config.js')
let status: typeof import('../src/printer-status.js')

beforeAll(async () => {
	process.env.THERMAL_CONFIG_PATH = join(tmpdir(), `ipp-test-${Math.random().toString(36).slice(2)}.json`)
	config = await import('../src/config.js')
	server = await import('../src/ipp/server.js')
	status = await import('../src/printer-status.js')
})

function opGroup() {
	return {
		tag: GroupTag.operation,
		attributes: [
			attr.charset('attributes-charset', 'utf-8'),
			attr.naturalLanguage('attributes-natural-language', 'en'),
			attr.uri('printer-uri', 'ipp://x/ipp/print'),
		],
	}
}

async function request(msg: IppMessage): Promise<IppMessage> {
	const printer = config.resolveAdvertisedPrinter('/ipp/print')
	return decode(await server.handleIppRequest(encode(msg), { printerUri: 'ipp://x/ipp/print', printer }))
}

function tinyPwg(w = 80, h = 40): Buffer {
	const header = Buffer.alloc(1796)
	header.writeUInt32BE(203, 276)
	header.writeUInt32BE(203, 280)
	header.writeUInt32BE(w, 372)
	header.writeUInt32BE(h, 376)
	header.writeUInt32BE(8, 384)
	header.writeUInt32BE(24, 388)
	header.writeUInt32BE(w * 3, 392)
	header.writeUInt32BE(19, 400)
	header.writeUInt32BE(3, 420)
	const rows: Buffer[] = []
	for (let y = 0; y < h; y++) {
		rows.push(Buffer.from([0]))
		let x = 0
		while (x < w) {
			const n = Math.min(128, w - x)
			rows.push(Buffer.from([257 - n]), Buffer.alloc(n * 3))
			x += n
		}
	}
	return Buffer.concat([Buffer.from('RaS2', 'latin1'), header, ...rows])
}

const printerGroup = (msg: IppMessage) => msg.groups.find((g) => g.tag === GroupTag.printer)!
const attrVal = (msg: IppMessage, name: string) => printerGroup(msg).attributes.find((a) => a.name === name)?.values[0].value

describe('IPP server', () => {
	it('Get-Printer-Attributes returns the required capabilities', async () => {
		const res = await request({
			versionMajor: 2,
			versionMinor: 0,
			code: 0x000b,
			requestId: 1,
			groups: [opGroup()],
			data: Buffer.alloc(0),
		})
		expect(res.code).toBe(0)
		const names = new Set(printerGroup(res).attributes.map((a) => a.name))
		for (const required of [
			'printer-uuid',
			'urf-supported',
			'document-format-supported',
			'media-default',
			'media-col-database',
			'printer-resolution-default',
			'printer-state',
		]) {
			expect(names.has(required)).toBe(true)
		}
	})

	it('reflects reachability in printer-state', async () => {
		config.setConfig({ printers: [{ id: 't', name: 'P', ip: '127.0.0.1', port: 9100, uuid: 'u' }], defaultPrinterId: 't' })

		await status.refreshPrinterStatus() // nothing listening → offline
		let res = await request({ versionMajor: 2, versionMinor: 0, code: 0x000b, requestId: 1, groups: [opGroup()], data: Buffer.alloc(0) })
		expect(attrVal(res, 'printer-state')).toBe(5) // stopped
		expect(attrVal(res, 'printer-state-reasons')).toBe('connecting-to-device')

		const mock = net.createServer(() => {})
		await new Promise<void>((r) => mock.listen(9100, '127.0.0.1', r))
		await status.refreshPrinterStatus() // now reachable → online
		res = await request({ versionMajor: 2, versionMinor: 0, code: 0x000b, requestId: 1, groups: [opGroup()], data: Buffer.alloc(0) })
		mock.close()
		expect(attrVal(res, 'printer-state')).toBe(3) // idle
		expect(attrVal(res, 'printer-state-reasons')).toBe('none')
	})

	it('Print-Job honors the requested copies', async () => {
		config.setConfig({ printers: [{ id: 't', name: 'P', ip: '127.0.0.1', port: 9100, uuid: 'u' }], defaultPrinterId: 't', paperWidthDots: 576 })
		const chunks: Buffer[] = []
		const mock = net.createServer((s) => s.on('data', (d) => chunks.push(d)))
		await new Promise<void>((r) => mock.listen(9100, '127.0.0.1', r))

		const res = await request({
			versionMajor: 2,
			versionMinor: 0,
			code: 0x0002, // Print-Job
			requestId: 9,
			groups: [opGroup(), { tag: GroupTag.job, attributes: [attr.int('copies', 3)] }],
			data: tinyPwg(),
		})
		expect(res.code).toBe(0)

		await new Promise((r) => setTimeout(r, 1200)) // job prints asynchronously
		mock.close()
		const buf = Buffer.concat(chunks)
		let cuts = 0
		for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x1b && buf[i + 1] === 0x69) cuts++
		expect(cuts).toBe(3)
	})
})
