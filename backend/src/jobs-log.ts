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
const entries: JobLogEntry[] = []
const payloads = new Map<number, Buffer>()
let nextId = 1

export function logJob(entry: Omit<JobLogEntry, 'id' | 'at'>, payload?: Buffer): number {
	const id = nextId++
	entries.unshift({ ...entry, id, at: Date.now() })
	if (payload && entry.status === 'ok') payloads.set(id, payload)
	if (entries.length > MAX_ENTRIES) {
		for (const removed of entries.splice(MAX_ENTRIES)) payloads.delete(removed.id)
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
