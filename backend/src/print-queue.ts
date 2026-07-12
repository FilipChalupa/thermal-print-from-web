/**
 * Serializes prints per physical printer and retries transient failures.
 *
 * ESC/POS printers typically accept a single raw connection at a time, so two
 * concurrent jobs (e.g. an IPP job and a web print) could interleave or fail.
 * This queue guarantees one job at a time per printer, and — using the
 * reachability probe — waits for a briefly-offline printer to come back instead
 * of dropping the job. Every attempt (success or final failure) is logged, with
 * the payload retained so it can be re-printed. The current queue is exposed for
 * a live "in progress" view in the UI.
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
	/** Raw-print port of the target printer (default 9100). */
	port?: number
}

export type QueueState = 'queued' | 'printing' | 'waiting'

interface QueueItem {
	id: number
	ip: string
	port: number
	payload: Buffer
	meta: PrintMeta
	state: QueueState
	resolve: () => void
	reject: (err: Error) => void
}

export interface QueueJobView {
	id: number
	ip: string
	name: string
	source: PrintMeta['source']
	state: QueueState
	copies?: number
	format?: PrintMeta['format']
}

const DEFAULT_PORT = 9100
const queues = new Map<string, QueueItem[]>()
const active = new Set<string>()
let queueJobId = 1

const MAX_WAIT_MS = Number(process.env.PRINT_QUEUE_MAX_WAIT_MS) || 45_000 // retry window for an offline printer
const RETRY_GAP_MS = Number(process.env.PRINT_QUEUE_RETRY_GAP_MS) || 3_000
const REACH_POLL_MS = 2_000

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const keyOf = (ip: string, port: number) => `${ip}:${port}`

/** Queue a fully-assembled ESC/POS payload for a printer. Resolves once printed. */
export function enqueuePrint(ip: string, payload: Buffer, meta: PrintMeta): Promise<void> {
	const port = meta.port ?? DEFAULT_PORT
	return new Promise((resolve, reject) => {
		const key = keyOf(ip, port)
		const q = queues.get(key) ?? []
		q.push({ id: queueJobId++, ip, port, payload, meta, state: 'queued', resolve, reject })
		queues.set(key, q)
		void drain(key)
	})
}

/** Jobs currently queued or printing, for the live UI view. */
export function getQueueJobs(): QueueJobView[] {
	const out: QueueJobView[] = []
	for (const q of queues.values()) {
		for (const it of q)
			out.push({ id: it.id, ip: it.ip, name: it.meta.name, source: it.meta.source, state: it.state, copies: it.meta.copies, format: it.meta.format })
	}
	return out
}

async function drain(key: string): Promise<void> {
	if (active.has(key)) return
	active.add(key)
	try {
		const q = queues.get(key)
		while (q && q.length) {
			const item = q[0]
			const { source, name, pages, copies, format } = item.meta
			try {
				await deliver(item)
				logJob({ source, printerIp: item.ip, name, pages, copies, format, status: 'ok' }, item.payload)
				item.resolve()
			} catch (err) {
				const error = err instanceof Error ? err.message : 'Chyba tisku'
				logJob({ source, printerIp: item.ip, name, pages, copies, format, status: 'error', error }, item.payload)
				notifyFailure(item.ip, name, error)
				item.reject(err instanceof Error ? err : new Error(error))
			}
			q.shift()
		}
	} finally {
		active.delete(key)
		if (!queues.get(key)?.length) queues.delete(key)
	}
}

async function deliver(item: QueueItem): Promise<void> {
	const deadline = Date.now() + MAX_WAIT_MS
	for (;;) {
		try {
			item.state = 'printing'
			await sendEscPos(item.ip, item.payload, item.port)
			return
		} catch (err) {
			if (Date.now() >= deadline) throw err
			item.state = 'waiting' // hold until the printer is back
			await waitReachable(item.ip, item.port, deadline)
			await delay(Math.min(RETRY_GAP_MS, Math.max(0, deadline - Date.now())))
		}
	}
}

async function waitReachable(ip: string, port: number, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		if (await tcpReachable(ip, port, 800)) return
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
