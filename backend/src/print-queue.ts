/**
 * Serializes prints per physical printer and retries transient failures.
 *
 * ESC/POS printers typically accept a single raw connection at a time, so two
 * concurrent jobs (e.g. an IPP job and a web print) could interleave or fail.
 * This queue guarantees one job at a time per printer IP, and — using the
 * reachability probe — waits for a briefly-offline printer to come back instead
 * of dropping the job. Every attempt (success or final failure) is logged, with
 * the payload retained so it can be re-printed.
 */
import { logJob } from './jobs-log.js'
import type { JobFormat } from './jobs-log.js'
import { tcpReachable } from './printer-status.js'
import { sendEscPos } from './printer.js'

export interface PrintMeta {
	source: 'ipp' | 'web' | 'test' | 'reprint'
	name: string
	pages?: number
	copies?: number
	format?: JobFormat
}

interface QueueItem {
	payload: Buffer
	meta: PrintMeta
	resolve: () => void
	reject: (err: Error) => void
}

const queues = new Map<string, QueueItem[]>()
const active = new Set<string>()

const MAX_WAIT_MS = Number(process.env.PRINT_QUEUE_MAX_WAIT_MS) || 45_000 // retry window for an offline printer
const RETRY_GAP_MS = Number(process.env.PRINT_QUEUE_RETRY_GAP_MS) || 3_000
const REACH_POLL_MS = 2_000

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Queue a fully-assembled ESC/POS payload for a printer. Resolves once printed. */
export function enqueuePrint(ip: string, payload: Buffer, meta: PrintMeta): Promise<void> {
	return new Promise((resolve, reject) => {
		const q = queues.get(ip) ?? []
		q.push({ payload, meta, resolve, reject })
		queues.set(ip, q)
		void drain(ip)
	})
}

async function drain(ip: string): Promise<void> {
	if (active.has(ip)) return
	active.add(ip)
	try {
		const q = queues.get(ip)
		while (q && q.length) {
			const item = q[0]
			const { source, name, pages, copies, format } = item.meta
			try {
				await deliver(ip, item.payload)
				logJob({ source, printerIp: ip, name, pages, copies, format, status: 'ok' }, item.payload)
				item.resolve()
			} catch (err) {
				const error = err instanceof Error ? err.message : 'Chyba tisku'
				logJob({ source, printerIp: ip, name, pages, copies, format, status: 'error', error })
				notifyFailure(ip, item.meta.name, error)
				item.reject(err instanceof Error ? err : new Error(error))
			}
			q.shift()
		}
	} finally {
		active.delete(ip)
		if (!queues.get(ip)?.length) queues.delete(ip)
	}
}

async function deliver(ip: string, payload: Buffer): Promise<void> {
	const deadline = Date.now() + MAX_WAIT_MS
	for (;;) {
		try {
			await sendEscPos(ip, payload)
			return
		} catch (err) {
			if (Date.now() >= deadline) throw err
			await waitReachable(ip, deadline) // hold until the printer is back
			await delay(Math.min(RETRY_GAP_MS, Math.max(0, deadline - Date.now())))
		}
	}
}

async function waitReachable(ip: string, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		if (await tcpReachable(ip, 800)) return
		await delay(REACH_POLL_MS)
	}
}

/** POST a failure to WEBHOOK_URL if configured (fire-and-forget), for alerting. */
function notifyFailure(printerIp: string, name: string, error: string): void {
	const url = process.env.WEBHOOK_URL
	if (!url) return
	fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event: 'print-failed', printerIp, name, error, at: new Date().toISOString() }),
	}).catch(() => {})
}
