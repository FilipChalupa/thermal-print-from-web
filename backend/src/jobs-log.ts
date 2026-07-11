/**
 * A small ring buffer of recent print jobs across all channels (driverless IPP,
 * web upload, test receipts), surfaced in the UI. Job metadata is persisted to
 * disk so the history survives restarts. The assembled ESC/POS payload is kept
 * in memory (within a budget) so recent jobs can be re-printed — payloads are
 * NOT persisted, so after a restart old jobs show up but aren't reprintable.
 */
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log } from './log.js'

export type JobFormat = 'image' | 'pdf' | 'raster' | 'text'

export interface JobLogEntry {
	id: number
	at: number
	source: 'ipp' | 'web' | 'test' | 'reprint'
	printerIp: string
	name: string
	pages?: number
	copies?: number
	format?: JobFormat
	status: 'ok' | 'error'
	error?: string
}

const MAX_ENTRIES = 50
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // don't retain a single huge job for reprint
const MAX_PAYLOAD_TOTAL_BYTES = 16 * 1024 * 1024 // total budget for retained payloads

const configPath = process.env.THERMAL_CONFIG_PATH
const JOBS_PATH =
	process.env.THERMAL_JOBS_PATH ||
	(configPath ? join(dirname(configPath), 'thermal-print-jobs.json') : join(homedir(), '.thermal-print-jobs.json'))

const entries: JobLogEntry[] = []
const payloads = new Map<number, Buffer>()
let payloadTotal = 0
let nextId = 1

let persist = false
let jobsPath = JOBS_PATH
let saveTimer: ReturnType<typeof setTimeout> | undefined

// --- Persistence -------------------------------------------------------------

export function readJobsFile(path = jobsPath): JobLogEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'))
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

export function writeJobsFile(path: string, list: JobLogEntry[]): void {
	const tmp = `${path}.tmp`
	writeFileSync(tmp, JSON.stringify(list))
	renameSync(tmp, path)
}

/** Load persisted job history and enable ongoing persistence. */
export function loadJobs(path = JOBS_PATH): void {
	jobsPath = path
	const loaded = readJobsFile(path)
	entries.length = 0
	entries.push(...loaded.slice(0, MAX_ENTRIES))
	nextId = entries.reduce((max, e) => Math.max(max, e.id), 0) + 1
	persist = true
}

/** Write the current history to disk now (used on shutdown). */
export function flushJobs(): void {
	if (saveTimer) {
		clearTimeout(saveTimer)
		saveTimer = undefined
	}
	try {
		writeJobsFile(jobsPath, entries)
	} catch (err) {
		log.error('Nepodařilo se uložit historii úloh:', err)
	}
}

function scheduleSave(): void {
	if (!persist || saveTimer) return
	saveTimer = setTimeout(() => {
		saveTimer = undefined
		flushJobs()
	}, 500)
}

// --- Log ---------------------------------------------------------------------

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
		while (payloadTotal > MAX_PAYLOAD_TOTAL_BYTES && payloads.size > 1) {
			dropPayload(Math.min(...payloads.keys()))
		}
	}

	// Cap the number of log entries; drop payloads of evicted entries.
	if (entries.length > MAX_ENTRIES) {
		for (const removed of entries.splice(MAX_ENTRIES)) dropPayload(removed.id)
	}

	scheduleSave()
	return id
}

export function getJobLog(): JobLogEntry[] {
	return entries
}

export function getJobEntry(id: number): JobLogEntry | undefined {
	return entries.find((e) => e.id === id)
}

/** Whether a job's payload is still retained (so it can be re-printed). */
export function hasPayload(id: number): boolean {
	return payloads.has(id)
}

/** The assembled ESC/POS payload of a successful job, for re-printing. */
export function getJobPayload(id: number): Buffer | undefined {
	return payloads.get(id)
}
