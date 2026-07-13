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
import type { PreviewImages } from './printer.js'

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
const MAX_PREVIEW_TOTAL_BYTES = 24 * 1024 * 1024 // total budget for retained previews (PNG)

const configPath = process.env.THERMAL_CONFIG_PATH
const JOBS_PATH =
	process.env.THERMAL_JOBS_PATH ||
	(configPath ? join(dirname(configPath), 'thermal-print-jobs.json') : join(homedir(), '.thermal-print-jobs.json'))

const entries: JobLogEntry[] = []
const payloads = new Map<number, Buffer>()
const previews = new Map<number, PreviewImages>()
let payloadTotal = 0
let previewTotal = 0
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

function previewBytes(p: PreviewImages): number {
	return p.full.length + p.thumb.length
}

function dropPreview(id: number): void {
	const p = previews.get(id)
	if (p) {
		previewTotal -= previewBytes(p)
		previews.delete(id)
	}
}

export function logJob(entry: Omit<JobLogEntry, 'id' | 'at'>, payload?: Buffer, preview?: PreviewImages): number {
	const id = nextId++
	entries.unshift({ ...entry, id, at: Date.now() })

	// Retain the payload (for reprint / retry, incl. failed jobs), within budgets.
	if (payload && payload.length <= MAX_PAYLOAD_BYTES) {
		payloads.set(id, payload)
		payloadTotal += payload.length
		while (payloadTotal > MAX_PAYLOAD_TOTAL_BYTES && payloads.size > 1) {
			dropPayload(Math.min(...payloads.keys()))
		}
	}

	// Retain preview images (to show in the history), within their own budget.
	if (preview) {
		previews.set(id, preview)
		previewTotal += previewBytes(preview)
		while (previewTotal > MAX_PREVIEW_TOTAL_BYTES && previews.size > 1) {
			dropPreview(Math.min(...previews.keys()))
		}
	}

	// Cap the number of log entries; drop retained blobs of evicted entries.
	if (entries.length > MAX_ENTRIES) {
		for (const removed of entries.splice(MAX_ENTRIES)) {
			dropPayload(removed.id)
			dropPreview(removed.id)
		}
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

/** Whether a job still has a retained preview image. */
export function hasPreview(id: number): boolean {
	return previews.has(id)
}

/** One rendition (full / thumb) of a job's preview, if still retained. */
export function getJobPreview(id: number, kind: keyof PreviewImages): Buffer | undefined {
	return previews.get(id)?.[kind]
}

/** Both preview renditions of a job (e.g. to carry over into a reprint). */
export function getJobPreviewImages(id: number): PreviewImages | undefined {
	return previews.get(id)
}
