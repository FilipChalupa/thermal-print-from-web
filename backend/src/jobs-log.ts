/**
 * A small in-memory ring buffer of recent print jobs across all channels (the
 * driverless IPP path, the web upload and test receipts), surfaced in the UI so
 * the user can see what was printed and whether it succeeded. The assembled
 * ESC/POS payload is kept per job so it can be re-printed.
 */
export interface JobLogEntry {
	id: number
	at: number
	source: 'ipp' | 'web' | 'test' | 'reprint'
	printerIp: string
	name: string
	pages?: number
	status: 'ok' | 'error'
	error?: string
}

const MAX_ENTRIES = 50
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // don't retain a single huge job for reprint
const MAX_PAYLOAD_TOTAL_BYTES = 16 * 1024 * 1024 // total budget for retained payloads

const entries: JobLogEntry[] = []
const payloads = new Map<number, Buffer>()
let payloadTotal = 0
let nextId = 1

function dropPayload(id: number): void {
	const buf = payloads.get(id)
	if (buf) {
		payloadTotal -= buf.length
		payloads.delete(id)
	}
}

export function logJob(entry: Omit<JobLogEntry, 'id' | 'at'>, payload?: Buffer): number {
	const id = nextId++
	entries.unshift({ ...entry, id, at: Date.now() })

	// Retain the payload for reprint, within per-job and total memory budgets.
	if (payload && entry.status === 'ok' && payload.length <= MAX_PAYLOAD_BYTES) {
		payloads.set(id, payload)
		payloadTotal += payload.length
		// Evict oldest payloads (smallest id) until under the total budget.
		while (payloadTotal > MAX_PAYLOAD_TOTAL_BYTES && payloads.size > 1) {
			dropPayload(Math.min(...payloads.keys()))
		}
	}

	// Cap the number of log entries; drop payloads of evicted entries.
	if (entries.length > MAX_ENTRIES) {
		for (const removed of entries.splice(MAX_ENTRIES)) dropPayload(removed.id)
	}
	return id
}

export function getJobLog(): JobLogEntry[] {
	return entries
}

export function getJobEntry(id: number): JobLogEntry | undefined {
	return entries.find((e) => e.id === id)
}

/** The assembled ESC/POS payload of a successful job, for re-printing. */
export function getJobPayload(id: number): Buffer | undefined {
	return payloads.get(id)
}
