/**
 * A small in-memory ring buffer of recent print jobs across all channels (the
 * driverless IPP path, the web upload and test receipts), surfaced in the UI so
 * the user can see what was printed and whether it succeeded.
 */
export interface JobLogEntry {
	id: number
	at: number
	source: 'ipp' | 'web' | 'test'
	printerIp: string
	name: string
	pages?: number
	status: 'ok' | 'error'
	error?: string
}

const MAX_ENTRIES = 50
const entries: JobLogEntry[] = []
let nextId = 1

export function logJob(entry: Omit<JobLogEntry, 'id' | 'at'>): void {
	entries.unshift({ ...entry, id: nextId++, at: Date.now() })
	if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
}

export function getJobLog(): JobLogEntry[] {
	return entries
}
