import { describe, expect, it } from 'vitest'
import { pickDefaultPrinter } from '../src/discovery.js'
import type { DiscoveredPrinter } from '../src/discovery.js'

const scan = (ip: string): DiscoveredPrinter => ({ ip, port: 9100, source: 'scan', verified: false })
const mdns = (ip: string): DiscoveredPrinter => ({ ip, port: 9100, source: 'mdns', name: 'EPSON', verified: true })

describe('pickDefaultPrinter', () => {
	it('prefers an mDNS-advertised printer over a bare scan hit', () => {
		expect(pickDefaultPrinter([scan('10.0.0.5'), mdns('10.0.0.9')])?.ip).toBe('10.0.0.9')
	})

	it('falls back to the first entry when none are mDNS', () => {
		expect(pickDefaultPrinter([scan('10.0.0.5'), scan('10.0.0.9')])?.ip).toBe('10.0.0.5')
	})

	it('returns undefined for an empty list', () => {
		expect(pickDefaultPrinter([])).toBeUndefined()
	})
})
