import { describe, expect, it } from 'vitest'
import { attr, decode, encode, findAttr, GroupTag, ValueTag } from '../src/ipp/encoding.js'
import type { IppMessage } from '../src/ipp/encoding.js'

function roundTrip(msg: IppMessage): IppMessage {
	return decode(encode(msg))
}

describe('IPP encoding', () => {
	it('round-trips the message header', () => {
		const msg: IppMessage = {
			versionMajor: 2,
			versionMinor: 0,
			code: 0x000b,
			requestId: 42,
			groups: [{ tag: GroupTag.operation, attributes: [attr.charset('attributes-charset', 'utf-8')] }],
			data: Buffer.alloc(0),
		}
		const back = roundTrip(msg)
		expect(back.versionMajor).toBe(2)
		expect(back.code).toBe(0x000b)
		expect(back.requestId).toBe(42)
	})

	it('round-trips scalar value types', () => {
		const group = {
			tag: GroupTag.printer,
			attributes: [
				attr.int('copies', 3),
				attr.enum('printer-state', 5),
				attr.bool('color-supported', false),
				attr.uri('printer-uri-supported', 'ipp://host/ipp/print'),
				attr.range('copies-supported', 1, 99),
				attr.resolution('printer-resolution-default', 203, 203),
			],
		}
		const back = roundTrip({ versionMajor: 1, versionMinor: 1, code: 0, requestId: 1, groups: [group], data: Buffer.alloc(0) })
		const p = back.groups.find((g) => g.tag === GroupTag.printer)!
		const byName = (n: string) => p.attributes.find((a) => a.name === n)!.values[0].value
		expect(byName('copies')).toBe(3)
		expect(byName('printer-state')).toBe(5)
		expect(byName('color-supported')).toBe(false)
		expect(byName('printer-uri-supported')).toBe('ipp://host/ipp/print')
		expect(byName('copies-supported')).toEqual({ lower: 1, upper: 99 })
		expect(byName('printer-resolution-default')).toEqual({ x: 203, y: 203, units: 3 })
	})

	it('round-trips a 1setOf keyword attribute', () => {
		const group = { tag: GroupTag.printer, attributes: [attr.keyword('ipp-versions-supported', ['1.1', '2.0'])] }
		const back = roundTrip({ versionMajor: 2, versionMinor: 0, code: 0, requestId: 1, groups: [group], data: Buffer.alloc(0) })
		const a = back.groups[0].attributes[0]
		expect(a.values.map((v) => v.value)).toEqual(['1.1', '2.0'])
	})

	it('round-trips a nested collection (media-col)', () => {
		const mediaCol = {
			name: 'media-col-database',
			values: [
				{
					tag: ValueTag.begCollection,
					value: {
						'media-size': [
							{
								tag: ValueTag.begCollection,
								value: {
									'x-dimension': [{ tag: ValueTag.integer, value: 8000 }],
									'y-dimension': [{ tag: ValueTag.integer, value: 29700 }],
								},
							},
						],
						'media-left-margin': [{ tag: ValueTag.integer, value: 0 }],
					},
				},
			],
		}
		const back = roundTrip({
			versionMajor: 2,
			versionMinor: 0,
			code: 0,
			requestId: 1,
			groups: [{ tag: GroupTag.printer, attributes: [mediaCol] }],
			data: Buffer.alloc(0),
		})
		const coll = back.groups[0].attributes[0].values[0].value as Record<string, { value: unknown }[]>
		const size = coll['media-size'][0].value as Record<string, { value: unknown }[]>
		expect(size['x-dimension'][0].value).toBe(8000)
		expect(size['y-dimension'][0].value).toBe(29700)
		expect(coll['media-left-margin'][0].value).toBe(0)
	})

	it('preserves the document payload after end-of-attributes', () => {
		const data = Buffer.from('RaS2 fake raster', 'latin1')
		const back = roundTrip({
			versionMajor: 2,
			versionMinor: 0,
			code: 0x0002,
			requestId: 7,
			groups: [{ tag: GroupTag.operation, attributes: [attr.charset('attributes-charset', 'utf-8')] }],
			data,
		})
		expect(back.data.equals(data)).toBe(true)
	})

	it('findAttr locates an attribute by group and name', () => {
		const msg: IppMessage = {
			versionMajor: 2,
			versionMinor: 0,
			code: 0x000b,
			requestId: 1,
			groups: [{ tag: GroupTag.operation, attributes: [attr.uri('printer-uri', 'ipp://x/ipp/print')] }],
			data: Buffer.alloc(0),
		}
		expect(findAttr(msg, GroupTag.operation, 'printer-uri')?.value).toBe('ipp://x/ipp/print')
		expect(findAttr(msg, GroupTag.job, 'copies')).toBeUndefined()
	})
})
