import { describe, expect, it } from 'vitest'
import { getJobPayload, logJob } from '../src/jobs-log.js'

const buf = (mb: number) => Buffer.alloc(Math.round(mb * 1024 * 1024))

describe('jobs log payload retention', () => {
	it('retains a successful job payload for reprint', () => {
		const id = logJob({ source: 'web', printerIp: '1.2.3.4', name: 'small', status: 'ok' }, Buffer.from('RECEIPT'))
		expect(getJobPayload(id)?.toString()).toBe('RECEIPT')
	})

	it('does not retain payloads of failed jobs', () => {
		const id = logJob({ source: 'web', printerIp: '1.2.3.4', name: 'failed', status: 'error' }, Buffer.from('X'))
		expect(getJobPayload(id)).toBeUndefined()
	})

	it('drops a single oversized payload (> per-job cap)', () => {
		const id = logJob({ source: 'ipp', printerIp: '1.2.3.4', name: 'huge', status: 'ok' }, buf(5))
		expect(getJobPayload(id)).toBeUndefined()
	})

	it('evicts oldest payloads once the total budget is exceeded', () => {
		// 5 × 4 MB = 20 MB > 16 MB budget → the first is evicted, the newest kept.
		const ids = [0, 1, 2, 3, 4].map((n) => logJob({ source: 'ipp', printerIp: '1.2.3.4', name: `big${n}`, status: 'ok' }, buf(4)))
		expect(getJobPayload(ids[0])).toBeUndefined() // oldest evicted
		expect(getJobPayload(ids[4])).toBeDefined() // newest retained
	})
})
