import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { getJobLog, getJobPayload, loadJobs, logJob, readJobsFile, writeJobsFile } from '../src/jobs-log.js'
import type { JobLogEntry } from '../src/jobs-log.js'

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

	it('round-trips job history through disk and reloads it', () => {
		const path = join(tmpdir(), `jobs-test-${Math.random().toString(36).slice(2)}.json`)
		const sample: JobLogEntry[] = [
			{ id: 7, at: 1000, source: 'ipp', printerIp: '10.0.0.9', name: 'Účtenka', status: 'ok', pages: 1 },
			{ id: 6, at: 900, source: 'web', printerIp: '10.0.0.9', name: 'foto', status: 'error', error: 'offline' },
		]
		writeJobsFile(path, sample)
		expect(readJobsFile(path)).toEqual(sample)

		// loadJobs restores history and continues ids after the max persisted one.
		loadJobs(path)
		expect(getJobLog().find((j) => j.name === 'Účtenka')).toBeTruthy()
		const nextId = logJob({ source: 'web', printerIp: 'x', name: 'after-load', status: 'ok' })
		expect(nextId).toBe(8) // max persisted id (7) + 1
	})
})
