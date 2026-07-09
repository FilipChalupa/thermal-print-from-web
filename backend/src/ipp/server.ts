/**
 * A minimal IPP Everywhere / AirPrint printer server. It implements just enough
 * of RFC 8011 + PWG 5100.x for macOS, Windows and Linux to discover the printer,
 * fetch its capabilities and submit raster jobs — which we decode and forward to
 * the physical thermal printer as ESC/POS.
 */
import { getConfig } from '../config.js'
import { printRasterPages } from '../printer.js'
import { attr, decode, encode, findAttr, GroupTag, ValueTag } from './encoding.js'
import type { IppAttribute, IppGroup, IppMessage } from './encoding.js'
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
export const PDL_SUPPORTED = ['image/urf', 'image/pwg-raster', 'application/octet-stream']
export const MAKE_AND_MODEL = 'Thermal Printer (ESC/POS bridge)'
const MEDIA_WIDTH_HMM = 8000 // 80 mm in hundredths of a millimetre
const MEDIA_HEIGHT_HMM = 29700 // 297 mm default page length
const MEDIA_NAME = 'om_80x297mm_80x297mm'

type JobState = 3 | 5 | 7 | 8 | 9 // pending | processing | canceled | aborted | completed

interface Job {
	id: number
	state: JobState
	name: string
	createdAt: number
	document: Buffer
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

function mediaColCollection(): IppAttribute {
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
								'x-dimension': [{ tag: ValueTag.integer, value: MEDIA_WIDTH_HMM }],
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

function buildPrinterAttributes(printerUri: string): IppGroup {
	const cfg = getConfig()
	const uuid = `urn:uuid:${cfg.printerUuid}`

	const attributes: IppAttribute[] = [
		attr.uri('printer-uri-supported', printerUri),
		attr.keyword('uri-authentication-supported', 'none'),
		attr.keyword('uri-security-supported', 'none'),
		attr.name('printer-name', cfg.printerName),
		attr.text('printer-info', cfg.printerName),
		attr.text('printer-make-and-model', 'Thermal Printer (ESC/POS bridge)'),
		attr.text('printer-location', ''),
		attr.uri('printer-uuid', uuid),
		attr.enum('printer-state', 3), // idle
		attr.keyword('printer-state-reasons', 'none'),
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
		attr.mime('document-format-supported', ['image/urf', 'image/pwg-raster', 'application/octet-stream']),
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
		// Media (80 mm roll).
		attr.keyword('media-supported', MEDIA_NAME),
		attr.keyword('media-default', MEDIA_NAME),
		attr.keyword('media-ready', MEDIA_NAME),
		mediaColCollection(),
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
	const cfg = getConfig()
	if (!cfg.printerIp) {
		job.state = 8 // aborted
		console.error('IPP job přijat, ale není nastavená IP termální tiskárny (printerIp).')
		return
	}
	try {
		job.state = 5 // processing
		const pages = decodeRaster(job.document)
		await printRasterPages(cfg.printerIp, pages, 1)
		job.state = 9 // completed
		console.log(`IPP job ${job.id}: vytištěno ${pages.length} stran na ${cfg.printerIp}`)
	} catch (err) {
		job.state = 8 // aborted
		console.error(`IPP job ${job.id} selhal:`, err)
	} finally {
		job.document = Buffer.alloc(0) // free memory
	}
}

// --- Operation dispatch ------------------------------------------------------

export interface IppContext {
	/** Absolute printer URI, e.g. ipp://192.168.1.10:6310/ipp/print */
	printerUri: string
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
			return encode(response(req, Status.ok, [buildPrinterAttributes(ctx.printerUri)]))

		case Op.ValidateJob:
			return encode(response(req, Status.ok))

		case Op.PrintJob: {
			const nameVal = findAttr(req, GroupTag.operation, 'job-name')
			const job: Job = {
				id: nextJobId++,
				state: 5,
				name: typeof nameVal?.value === 'string' ? nameVal.value : 'Print job',
				createdAt: Date.now(),
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
