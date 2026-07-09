/**
 * Minimal IPP (RFC 8010) binary message encoder/decoder.
 *
 * An IPP message is:
 *   version (2 bytes)  |  operation-id / status-code (2 bytes)  |  request-id (4 bytes)
 *   one or more attribute groups, each introduced by a delimiter tag
 *   end-of-attributes-tag (0x03)
 *   optional document data (the rest of the stream)
 *
 * We keep an explicit value-tag on every value so a server can round-trip and
 * emit exactly the types clients expect (keyword vs. name vs. uri, etc.).
 */

// Delimiter (group) tags
export const GroupTag = {
	operation: 0x01,
	job: 0x02,
	end: 0x03,
	printer: 0x04,
	unsupported: 0x05,
} as const

// Value tags
export const ValueTag = {
	unsupported: 0x10,
	unknown: 0x12,
	noValue: 0x13,
	integer: 0x21,
	boolean: 0x22,
	enum: 0x23,
	octetString: 0x30,
	dateTime: 0x31,
	resolution: 0x32,
	rangeOfInteger: 0x33,
	begCollection: 0x34,
	textWithLanguage: 0x35,
	nameWithLanguage: 0x36,
	endCollection: 0x37,
	textWithoutLanguage: 0x41,
	nameWithoutLanguage: 0x42,
	keyword: 0x44,
	uri: 0x45,
	uriScheme: 0x46,
	charset: 0x47,
	naturalLanguage: 0x48,
	mimeMediaType: 0x49,
	memberAttrName: 0x4a,
} as const

export interface Resolution {
	x: number
	y: number
	units: number // 3 = dpi, 4 = dots per cm
}

export interface IntRange {
	lower: number
	upper: number
}

export interface IppCollection {
	[member: string]: IppValue[]
}

export type IppScalar = number | boolean | string | Buffer | Resolution | IntRange | IppCollection

export interface IppValue {
	tag: number
	value: IppScalar
}

export interface IppAttribute {
	name: string
	values: IppValue[]
}

export interface IppGroup {
	tag: number
	attributes: IppAttribute[]
}

export interface IppMessage {
	versionMajor: number
	versionMinor: number
	/** operation-id on requests, status-code on responses */
	code: number
	requestId: number
	groups: IppGroup[]
	/** document payload following end-of-attributes-tag */
	data: Buffer
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

class Reader {
	offset = 0
	constructor(private buf: Buffer) {}
	u8() {
		return this.buf[this.offset++]
	}
	u16() {
		const v = this.buf.readUInt16BE(this.offset)
		this.offset += 2
		return v
	}
	i32() {
		const v = this.buf.readInt32BE(this.offset)
		this.offset += 4
		return v
	}
	bytes(n: number) {
		const v = this.buf.subarray(this.offset, this.offset + n)
		this.offset += n
		return v
	}
	str(n: number) {
		return this.bytes(n).toString('utf8')
	}
	get remaining() {
		return this.buf.length - this.offset
	}
	peek() {
		return this.buf[this.offset]
	}
}

function decodeValue(tag: number, raw: Buffer): IppScalar {
	switch (tag) {
		case ValueTag.integer:
		case ValueTag.enum:
			return raw.readInt32BE(0)
		case ValueTag.boolean:
			return raw[0] !== 0
		case ValueTag.resolution:
			return { x: raw.readInt32BE(0), y: raw.readInt32BE(4), units: raw[8] }
		case ValueTag.rangeOfInteger:
			return { lower: raw.readInt32BE(0), upper: raw.readInt32BE(4) }
		case ValueTag.octetString:
		case ValueTag.dateTime:
		case ValueTag.unsupported:
		case ValueTag.unknown:
		case ValueTag.noValue:
			return raw
		default:
			return raw.toString('utf8')
	}
}

export function decode(buf: Buffer): IppMessage {
	const r = new Reader(buf)
	const versionMajor = r.u8()
	const versionMinor = r.u8()
	const code = r.u16()
	const requestId = r.i32()

	const groups: IppGroup[] = []
	let current: IppGroup | null = null
	let lastAttr: IppAttribute | null = null
	// Stack of collections currently being assembled (for nested collections).
	const collStack: { attr: IppAttribute; coll: IppCollection; memberName: string | null }[] = []

	while (r.remaining > 0) {
		const tag = r.u8()

		if (tag <= 0x05) {
			// Delimiter tag => new group (or end).
			if (tag === GroupTag.end) break
			current = { tag, attributes: [] }
			groups.push(current)
			lastAttr = null
			continue
		}

		const nameLen = r.u16()
		const name = r.str(nameLen)
		const valueLen = r.u16()
		const raw = r.bytes(valueLen)

		// --- Collection assembly ---
		if (tag === ValueTag.begCollection) {
			const coll: IppCollection = {}
			const attr: IppAttribute = { name, values: [{ tag, value: coll }] }
			if (collStack.length > 0) {
				// nested: attach as a member value of the enclosing collection
				const parent = collStack[collStack.length - 1]
				if (parent.memberName) parent.coll[parent.memberName] = [{ tag, value: coll }]
			} else if (current) {
				if (nameLen > 0) {
					current.attributes.push(attr)
					lastAttr = attr
				} else if (lastAttr) {
					lastAttr.values.push({ tag, value: coll })
				}
			}
			collStack.push({ attr, coll, memberName: null })
			continue
		}
		if (tag === ValueTag.memberAttrName) {
			if (collStack.length > 0) collStack[collStack.length - 1].memberName = raw.toString('utf8')
			continue
		}
		if (tag === ValueTag.endCollection) {
			collStack.pop()
			continue
		}
		if (collStack.length > 0) {
			const top = collStack[collStack.length - 1]
			if (top.memberName) {
				;(top.coll[top.memberName] ||= []).push({ tag, value: decodeValue(tag, raw) })
			}
			continue
		}

		// --- Normal attribute ---
		const value: IppValue = { tag, value: decodeValue(tag, raw) }
		if (nameLen === 0 && lastAttr) {
			lastAttr.values.push(value) // additional value of a 1setOf
		} else if (current) {
			lastAttr = { name, values: [value] }
			current.attributes.push(lastAttr)
		}
	}

	return {
		versionMajor,
		versionMinor,
		code,
		requestId,
		groups,
		data: r.remaining > 0 ? Buffer.from(r.bytes(r.remaining)) : Buffer.alloc(0),
	}
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodeScalar(tag: number, value: IppScalar): Buffer {
	switch (tag) {
		case ValueTag.integer:
		case ValueTag.enum: {
			const b = Buffer.alloc(4)
			b.writeInt32BE(value as number, 0)
			return b
		}
		case ValueTag.boolean:
			return Buffer.from([value ? 1 : 0])
		case ValueTag.resolution: {
			const r = value as Resolution
			const b = Buffer.alloc(9)
			b.writeInt32BE(r.x, 0)
			b.writeInt32BE(r.y, 4)
			b[8] = r.units
			return b
		}
		case ValueTag.rangeOfInteger: {
			const r = value as IntRange
			const b = Buffer.alloc(8)
			b.writeInt32BE(r.lower, 0)
			b.writeInt32BE(r.upper, 4)
			return b
		}
		case ValueTag.octetString:
		case ValueTag.dateTime:
			return Buffer.isBuffer(value) ? value : Buffer.from(String(value))
		default:
			return Buffer.from(String(value), 'utf8')
	}
}

function encodeAttrValue(name: string, v: IppValue): Buffer {
	const parts: Buffer[] = []

	if (v.tag === ValueTag.begCollection) {
		// begCollection: name then empty value
		parts.push(tagNameValue(v.tag, name, Buffer.alloc(0)))
		const coll = v.value as IppCollection
		for (const [member, values] of Object.entries(coll)) {
			// memberAttrName (unnamed), value = member name
			parts.push(tagNameValue(ValueTag.memberAttrName, '', Buffer.from(member, 'utf8')))
			for (const mv of values) {
				parts.push(encodeAttrValue('', mv))
			}
		}
		parts.push(tagNameValue(ValueTag.endCollection, '', Buffer.alloc(0)))
		return Buffer.concat(parts)
	}

	return tagNameValue(v.tag, name, encodeScalar(v.tag, v.value))
}

function tagNameValue(tag: number, name: string, value: Buffer): Buffer {
	const nameBuf = Buffer.from(name, 'utf8')
	const head = Buffer.alloc(1 + 2 + nameBuf.length + 2)
	head[0] = tag
	head.writeUInt16BE(nameBuf.length, 1)
	nameBuf.copy(head, 3)
	head.writeUInt16BE(value.length, 3 + nameBuf.length)
	return Buffer.concat([head, value])
}

export function encode(msg: IppMessage): Buffer {
	const parts: Buffer[] = []
	const header = Buffer.alloc(8)
	header[0] = msg.versionMajor
	header[1] = msg.versionMinor
	header.writeUInt16BE(msg.code, 2)
	header.writeInt32BE(msg.requestId, 4)
	parts.push(header)

	for (const group of msg.groups) {
		parts.push(Buffer.from([group.tag]))
		for (const attr of group.attributes) {
			// First value carries the attribute name; subsequent values are unnamed (1setOf).
			attr.values.forEach((v, i) => {
				parts.push(encodeAttrValue(i === 0 ? attr.name : '', v))
			})
		}
	}

	parts.push(Buffer.from([GroupTag.end]))
	if (msg.data && msg.data.length > 0) parts.push(msg.data)
	return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Convenience helpers for building attributes
// ---------------------------------------------------------------------------

export const attr = {
	charset: (name: string, v: string): IppAttribute => ({ name, values: [{ tag: ValueTag.charset, value: v }] }),
	naturalLanguage: (name: string, v: string): IppAttribute => ({
		name,
		values: [{ tag: ValueTag.naturalLanguage, value: v }],
	}),
	uri: (name: string, v: string): IppAttribute => ({ name, values: [{ tag: ValueTag.uri, value: v }] }),
	keyword: (name: string, v: string | string[]): IppAttribute => ({
		name,
		values: (Array.isArray(v) ? v : [v]).map((k) => ({ tag: ValueTag.keyword, value: k })),
	}),
	name: (name: string, v: string): IppAttribute => ({ name, values: [{ tag: ValueTag.nameWithoutLanguage, value: v }] }),
	text: (name: string, v: string): IppAttribute => ({ name, values: [{ tag: ValueTag.textWithoutLanguage, value: v }] }),
	mime: (name: string, v: string | string[]): IppAttribute => ({
		name,
		values: (Array.isArray(v) ? v : [v]).map((k) => ({ tag: ValueTag.mimeMediaType, value: k })),
	}),
	int: (name: string, v: number | number[]): IppAttribute => ({
		name,
		values: (Array.isArray(v) ? v : [v]).map((n) => ({ tag: ValueTag.integer, value: n })),
	}),
	enum: (name: string, v: number | number[]): IppAttribute => ({
		name,
		values: (Array.isArray(v) ? v : [v]).map((n) => ({ tag: ValueTag.enum, value: n })),
	}),
	bool: (name: string, v: boolean): IppAttribute => ({ name, values: [{ tag: ValueTag.boolean, value: v }] }),
	range: (name: string, lower: number, upper: number): IppAttribute => ({
		name,
		values: [{ tag: ValueTag.rangeOfInteger, value: { lower, upper } }],
	}),
	resolution: (name: string, x: number, y: number, units = 3): IppAttribute => ({
		name,
		values: [{ tag: ValueTag.resolution, value: { x, y, units } }],
	}),
}

/** Find the first value of a named attribute in the given group tag. */
export function findAttr(msg: IppMessage, groupTag: number, name: string): IppValue | undefined {
	for (const g of msg.groups) {
		if (g.tag !== groupTag) continue
		const a = g.attributes.find((x) => x.name === name)
		if (a) return a.values[0]
	}
	return undefined
}
