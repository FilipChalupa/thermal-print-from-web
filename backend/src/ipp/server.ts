/**
 * A minimal IPP Everywhere / AirPrint printer server. It implements just enough
 * of RFC 8011 + PWG 5100.x for macOS, Windows and Linux to discover the printer,
 * fetch its capabilities and submit raster jobs — which we decode and forward to
 * the physical thermal printer as ESC/POS.
 */
import { getConfig, paperWidthHmm } from '../config.js'
import { log } from '../log.js'
import type { AdvertisedPrinter } from '../config.js'
import { logJob } from '../jobs-log.js'
import { enqueuePrint } from '../print-queue.js'
import { getPrinterStatus } from '../printer-status.js'
import { buildRasterPayload } from '../printer.js'
import { attr, decode, encode, findAttr, GroupTag, ValueTag } from './encoding.js'
import type { IppAttribute, IppGroup, IppMessage } from './encoding.js'
import { renderPdfToPages } from './pdf.js'
import { decodeRaster } from './pwg-raster.js'

// IPP operation ids we handle.
const Op = {
	PrintJob: 0x0002,
	ValidateJob: 0x0004,
	CreateJob: 0x0005,
	SendDocument: 0x0006,
	CancelJob: 0x0008,
	GetJobAttributes: 0x0009,
	GetJobs: 0x000a,
	GetPrinterAttributes: 0x000b,
} as const

// IPP status codes.
const Status = {
	ok: 0x0000,
	clientErrorBadRequest: 0x0400,
	clientErrorNotFound: 0x0406,
	serverErrorOperationNotSupported: 0x0501,
	serverErrorInternalError: 0x0500,
} as const

// Thermal printer geometry. 203 dpi (8 dots/mm), 80 mm roll, ~72 mm printable.
const DPI = 203

/** Document formats we accept, shared with the mDNS `pdl` TXT record. */
export const PDL_SUPPORTED = ['image/urf', 'image/pwg-raster', 'application/pdf', 'application/octet-stream']
export const MAKE_AND_MODEL = 'Thermal Printer (ESC/POS bridge)'
const MEDIA_HEIGHT_HMM = 29700 // 297 mm default page length

type JobState = 3 | 5 | 7 | 8 | 9 // pending | processing | canceled | aborted | completed

interface Job {
	id: number
	state: JobState
	name: string
	createdAt: number
	copies: number
	target: AdvertisedPrinter
	document: Buffer
}

function readCopies(req: IppMessage): number {
	const v = findAttr(req, GroupTag.job, 'copies')?.value
	const n = typeof v === 'number' ? v : 1
	return Math.max(1, Math.min(99, n))
}

const jobs = new Map<number, Job>()
let nextJobId = 1
const bootTime = Date.now()

function uptime(): number {
	return Math.floor((Date.now() - bootTime) / 1000)
}

// --- Printer attributes ------------------------------------------------------

/** URF is Apple's capability string; required for AirPrint on macOS/iOS. */
export const URF_SUPPORTED = ['V1.4', 'CP1', `RS${DPI}`, 'W8', 'SRGB24', 'DM1', 'FN3', 'PQ4']

function mediaColCollection(widthHmm: number): IppAttribute {
	return {
		name: 'media-col-database',
		values: [
			{
				tag: ValueTag.begCollection,
				value: {
					'media-size': [
						{
							tag: ValueTag.begCollection,
							value: {
								'x-dimension': [{ tag: ValueTag.integer, value: widthHmm }],
								'y-dimension': [{ tag: ValueTag.integer, value: MEDIA_HEIGHT_HMM }],
							},
						},
					],
					'media-bottom-margin': [{ tag: ValueTag.integer, value: 0 }],
					'media-top-margin': [{ tag: ValueTag.integer, value: 0 }],
					'media-left-margin': [{ tag: ValueTag.integer, value: 0 }],
					'media-right-margin': [{ tag: ValueTag.integer, value: 0 }],
				},
			},
		],
	}
}

/** Map the monitored primary-printer status to an IPP state + reason. */
function ippState(targetIp: string): { printerState: number; stateReasons: string } {
	const s = getPrinterStatus()
	if (s.reachable === null) return { printerState: 3, stateReasons: 'none' } // not probed yet
	if (!s.reachable) return { printerState: 5, stateReasons: targetIp ? 'connecting-to-device' : 'other' }
	if (s.paperOut) return { printerState: 5, stateReasons: 'media-empty' }
	if (s.coverOpen) return { printerState: 5, stateReasons: 'cover-open' }
	if (!s.online) return { printerState: 5, stateReasons: 'moving-to-paused' }
	return { printerState: 3, stateReasons: 'none' }
}

function buildPrinterAttributes(printerUri: string, printer: AdvertisedPrinter): IppGroup {
	const cfg = getConfig()
	const uuid = `urn:uuid:${printer.uuid}`
	const mediaWidthHmm = paperWidthHmm(cfg.paperWidthDots)
	const mediaName = `om_${mediaWidthHmm / 100}x${MEDIA_HEIGHT_HMM / 100}mm_${mediaWidthHmm / 100}x${MEDIA_HEIGHT_HMM / 100}mm`

	// Reflect the downstream printer's condition (offline / out of paper / cover
	// open) so the OS shows the queue accordingly. We only actively monitor the
	// primary printer; extra queues are optimistically idle.
	const { printerState, stateReasons } = printer.primary
		? ippState(printer.targetIp)
		: { printerState: 3, stateReasons: 'none' }

	const attributes: IppAttribute[] = [
		attr.uri('printer-uri-supported', printerUri),
		attr.keyword('uri-authentication-supported', 'none'),
		attr.keyword('uri-security-supported', 'none'),
		attr.name('printer-name', printer.name),
		attr.text('printer-info', printer.name),
		attr.text('printer-make-and-model', MAKE_AND_MODEL),
		attr.text('printer-location', ''),
		attr.uri('printer-uuid', uuid),
		attr.enum('printer-state', printerState),
		attr.keyword('printer-state-reasons', stateReasons),
		attr.bool('printer-is-accepting-jobs', true),
		attr.keyword('ipp-versions-supported', ['1.1', '2.0']),
		attr.keyword('ipp-features-supported', ['ipp-everywhere']),
		attr.enum('operations-supported', [
			Op.PrintJob,
			Op.ValidateJob,
			Op.CreateJob,
			Op.SendDocument,
			Op.CancelJob,
			Op.GetJobAttributes,
			Op.GetJobs,
			Op.GetPrinterAttributes,
		]),
		attr.charset('charset-configured', 'utf-8'),
		attr.charset('charset-supported', 'utf-8'),
		attr.naturalLanguage('natural-language-configured', 'en'),
		attr.naturalLanguage('generated-natural-language-supported', 'en'),
		attr.mime('document-format-default', 'image/urf'),
		attr.mime('document-format-supported', PDL_SUPPORTED),
		attr.keyword('compression-supported', 'none'),
		attr.keyword('pdl-override-supported', 'attempted'),
		attr.int('queued-job-count', jobs.size),
		attr.int('printer-up-time', uptime()),
		attr.bool('color-supported', false),
		attr.keyword('print-color-mode-supported', ['monochrome', 'auto']),
		attr.keyword('print-color-mode-default', 'monochrome'),
		attr.enum('print-quality-supported', [3, 4, 5]),
		attr.enum('print-quality-default', 4),
		attr.resolution('printer-resolution-supported', DPI, DPI),
		attr.resolution('printer-resolution-default', DPI, DPI),
		attr.keyword('sides-supported', 'one-sided'),
		attr.keyword('sides-default', 'one-sided'),
		attr.enum('finishings-supported', 3), // none
		attr.enum('finishings-default', 3),
		attr.keyword('output-bin-supported', 'face-up'),
		attr.keyword('output-bin-default', 'face-up'),
		// Media (roll; width follows the configured paper size).
		attr.keyword('media-supported', mediaName),
		attr.keyword('media-default', mediaName),
		attr.keyword('media-ready', mediaName),
		mediaColCollection(mediaWidthHmm),
		attr.keyword('media-source-supported', 'main'),
		attr.keyword('media-type-supported', 'labels'),
		attr.range('copies-supported', 1, 99),
		attr.int('copies-default', 1),
		attr.keyword('urf-supported', URF_SUPPORTED),
		attr.keyword('job-creation-attributes-supported', [
			'copies',
			'media',
			'media-col',
			'print-color-mode',
			'print-quality',
			'printer-resolution',
			'sides',
		]),
		attr.keyword('which-jobs-supported', ['completed', 'not-completed']),
		attr.bool('multiple-document-jobs-supported', false),
		attr.int('multiple-operation-time-out', 60),
		attr.enum('orientation-requested-supported', [3, 4, 5, 6]),
		attr.enum('orientation-requested-default', 3),
		attr.keyword('identify-actions-supported', 'display'),
		attr.keyword('identify-actions-default', 'display'),
		attr.int('pages-per-minute', 30),
	]

	return { tag: GroupTag.printer, attributes }
}

// --- Response helpers --------------------------------------------------------

function operationGroup(): IppGroup {
	return {
		tag: GroupTag.operation,
		attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')],
	}
}

function response(req: IppMessage, status: number, extraGroups: IppGroup[] = []): IppMessage {
	return {
		versionMajor: req.versionMajor,
		versionMinor: req.versionMinor,
		code: status,
		requestId: req.requestId,
		groups: [operationGroup(), ...extraGroups],
		data: Buffer.alloc(0),
	}
}

function jobGroup(job: Job, printerUri: string): IppGroup {
	return {
		tag: GroupTag.job,
		attributes: [
			attr.uri('job-uri', `${printerUri}/${job.id}`),
			attr.int('job-id', job.id),
			attr.enum('job-state', job.state),
			attr.keyword('job-state-reasons', job.state === 9 ? 'job-completed-successfully' : 'none'),
			attr.name('job-name', job.name),
			attr.int('time-at-creation', Math.floor((job.createdAt - bootTime) / 1000)),
		],
	}
}

// --- Job processing ----------------------------------------------------------

async function processJob(job: Job): Promise<void> {
	const ip = job.target.targetIp
	if (!ip) {
		job.state = 8 // aborted
		log.error('IPP job přijat, ale tiskárna nemá nastavenou cílovou IP.')
		logJob({ source: 'ipp', printerIp: '', name: job.name, status: 'error', error: 'Není nastavená cílová tiskárna' })
		job.document = Buffer.alloc(0)
		return
	}
	try {
		job.state = 5 // processing
		// The OS sends either raster (PWG/URF) or PDF; sniff the magic bytes.
		const isPdf = job.document.subarray(0, 5).toString('latin1') === '%PDF-'
		const pages = isPdf ? await renderPdfToPages(job.document, getConfig().paperWidthDots) : decodeRaster(job.document)
		const payload = await buildRasterPayload(pages, job.copies)
		// The queue serializes + retries + logs the job (with payload for reprint).
		await enqueuePrint(ip, payload, {
			source: 'ipp',
			name: job.name,
			pages: pages.length,
			copies: job.copies,
			format: isPdf ? 'pdf' : 'raster',
			port: job.target.targetPort,
		})
		job.state = 9 // completed
	} catch {
		job.state = 8 // aborted (already logged by the queue)
	} finally {
		job.document = Buffer.alloc(0) // free memory
	}
}

// --- Operation dispatch ------------------------------------------------------

export interface IppContext {
	/** Absolute printer URI, e.g. ipp://192.168.1.10:6310/ipp/print */
	printerUri: string
	/** The advertised printer this request is addressed to (resolved from the path). */
	printer: AdvertisedPrinter
}

export async function handleIppRequest(body: Buffer, ctx: IppContext): Promise<Buffer> {
	let req: IppMessage
	try {
		req = decode(body)
	} catch {
		return encode({
			versionMajor: 1,
			versionMinor: 1,
			code: Status.clientErrorBadRequest,
			requestId: 1,
			groups: [operationGroup()],
			data: Buffer.alloc(0),
		})
	}

	switch (req.code) {
		case Op.GetPrinterAttributes:
			return encode(response(req, Status.ok, [buildPrinterAttributes(ctx.printerUri, ctx.printer)]))

		case Op.ValidateJob:
			return encode(response(req, Status.ok))

		case Op.PrintJob: {
			const nameVal = findAttr(req, GroupTag.operation, 'job-name')
			const job: Job = {
				id: nextJobId++,
				state: 5,
				name: typeof nameVal?.value === 'string' ? nameVal.value : 'Print job',
				createdAt: Date.now(),
				copies: readCopies(req),
				target: ctx.printer,
				document: req.data,
			}
			jobs.set(job.id, job)
			// Reply first, print asynchronously.
			void processJob(job)
			return encode(response(req, Status.ok, [jobGroup(job, ctx.printerUri)]))
		}

		case Op.CreateJob: {
			const nameVal = findAttr(req, GroupTag.operation, 'job-name')
			const job: Job = {
				id: nextJobId++,
				state: 3, // pending, waiting for Send-Document
				name: typeof nameVal?.value === 'string' ? nameVal.value : 'Print job',
				createdAt: Date.now(),
				copies: readCopies(req),
				target: ctx.printer,
				document: Buffer.alloc(0),
			}
			jobs.set(job.id, job)
			return encode(response(req, Status.ok, [jobGroup(job, ctx.printerUri)]))
		}

		case Op.SendDocument: {
			const idVal = findAttr(req, GroupTag.operation, 'job-id')
			const job = typeof idVal?.value === 'number' ? jobs.get(idVal.value) : undefined
			if (!job) return encode(response(req, Status.clientErrorNotFound))
			job.document = Buffer.concat([job.document, req.data])
			const lastVal = findAttr(req, GroupTag.operation, 'last-document')
			const isLast = lastVal ? lastVal.value === true : true
			if (isLast) void processJob(job)
			return encode(response(req, Status.ok, [jobGroup(job, ctx.printerUri)]))
		}

		case Op.GetJobAttributes: {
			const idVal = findAttr(req, GroupTag.operation, 'job-id')
			const job = typeof idVal?.value === 'number' ? jobs.get(idVal.value) : undefined
			if (!job) return encode(response(req, Status.clientErrorNotFound))
			return encode(response(req, Status.ok, [jobGroup(job, ctx.printerUri)]))
		}

		case Op.GetJobs: {
			const groups = [...jobs.values()].map((j) => jobGroup(j, ctx.printerUri))
			return encode(response(req, Status.ok, groups))
		}

		case Op.CancelJob: {
			const idVal = findAttr(req, GroupTag.operation, 'job-id')
			const job = typeof idVal?.value === 'number' ? jobs.get(idVal.value) : undefined
			if (job && job.state < 7) job.state = 7 // canceled
			return encode(response(req, Status.ok))
		}

		default:
			return encode(response(req, Status.serverErrorOperationNotSupported))
	}
}
