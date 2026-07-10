import net from 'net'
import { describe, expect, it } from 'vitest'
import { tcpReachable } from '../src/printer-status.js'

describe('tcpReachable', () => {
	it('is false for an unset IP', async () => {
		expect(await tcpReachable('')).toBe(false)
	})

	it('is false when nothing listens on :9100', async () => {
		expect(await tcpReachable('127.0.0.1', 400)).toBe(false)
	})

	it('is true when a server accepts on :9100', async () => {
		const server = net.createServer(() => {})
		await new Promise<void>((r) => server.listen(9100, '127.0.0.1', r))
		try {
			expect(await tcpReachable('127.0.0.1')).toBe(true)
		} finally {
			server.close()
		}
	})
})
