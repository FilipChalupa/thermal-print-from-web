import net from 'net'
import { describe, expect, it } from 'vitest'
import { getJobLog, getJobPayload } from '../src/jobs-log.js'
import { enqueuePrint } from '../src/print-queue.js'

const IP = '127.0.0.1'

function mockPrinter(): { chunks: Buffer[]; server: net.Server } {
	const chunks: Buffer[] = []
	const server = net.createServer((s) => s.on('data', (d) => chunks.push(d)))
	return { chunks, server }
}
const listen = (server: net.Server) => new Promise<void>((r) => server.listen(9100, IP, r))

describe('print queue', () => {
	it('serializes jobs to the same printer in order', async () => {
		const { chunks, server } = mockPrinter()
		await listen(server)
		try {
			await Promise.all([
				enqueuePrint(IP, Buffer.from('AAA'), { source: 'test', name: 'a' }),
				enqueuePrint(IP, Buffer.from('BBB'), { source: 'test', name: 'b' }),
			])
			expect(Buffer.concat(chunks).toString()).toBe('AAABBB')
		} finally {
			server.close()
		}
	})

	it('sends to the printer on its configured port', async () => {
		const chunks: Buffer[] = []
		const server = net.createServer((s) => s.on('data', (d) => chunks.push(d)))
		await new Promise<void>((r) => server.listen(9110, IP, r))
		try {
			await enqueuePrint(IP, Buffer.from('PORTED'), { source: 'web', name: 'p', port: 9110 })
			expect(Buffer.concat(chunks).toString()).toBe('PORTED')
		} finally {
			server.close()
		}
	})

	it('rejects and logs when the printer never comes online', async () => {
		await expect(enqueuePrint('192.0.2.1', Buffer.from('X'), { source: 'test', name: 'unreachable' })).rejects.toThrow()
		expect(getJobLog().some((j) => j.name === 'unreachable' && j.status === 'error')).toBe(true)
	}, 60_000)

	it('retains the payload of a successful job for reprint', async () => {
		const { chunks, server } = mockPrinter()
		await listen(server)
		try {
			await enqueuePrint(IP, Buffer.from('RECEIPT'), { source: 'web', name: 'reprint-me' })
			const job = getJobLog().find((j) => j.name === 'reprint-me')
			expect(job).toBeDefined()
			expect(getJobPayload(job!.id)?.toString()).toBe('RECEIPT')

			// Re-print from the retained payload.
			await enqueuePrint(IP, getJobPayload(job!.id)!, { source: 'reprint', name: 'reprint-me' })
			expect(Buffer.concat(chunks).toString()).toBe('RECEIPTRECEIPT')
		} finally {
			server.close()
		}
	})
})
