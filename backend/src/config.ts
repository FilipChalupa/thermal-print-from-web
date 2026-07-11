import { randomUUID } from 'crypto'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './log.js'

/**
 * Persisted config. The core is a single list of network printers — each is
 * advertised as its own driverless (AirPrint / IPP Everywhere) queue and forwards
 * to a physical ESC/POS printer. One printer is the default (the "star"): it takes
 * the canonical `ipp/print` path and pre-selects the manual web print.
 */
export interface NetworkPrinter {
	id: string
	name: string
	/** IP of the physical ESC/POS printer this queue forwards to. */
	ip: string
	/** Stable UUID advertised over IPP so clients recognise the same printer. */
	uuid: string
}

/** A printer as advertised over mDNS + IPP. */
export interface AdvertisedPrinter {
	name: string
	uuid: string
	targetIp: string
	resourcePath: string
	primary: boolean
}

export interface Config {
	/** Print width in dots: 576 for 80 mm paper, 384 for 58 mm (both @ 203 dpi). */
	paperWidthDots: number
	/** Halftoning algorithm applied when converting images to 1-bit. */
	ditherAlgorithm: DitherAlgorithm
	/** Brightness adjustment, -100…100 (applied before dithering). */
	brightness: number
	/** Contrast adjustment, -100…100 (applied before dithering). */
	contrast: number
	/** All configured network printers (each its own driverless queue). */
	printers: NetworkPrinter[]
	/** Id of the default printer (the "star"). */
	defaultPrinterId: string
}

export type DitherAlgorithm = 'floyd' | 'atkinson' | 'ordered' | 'threshold'
export const DITHER_ALGORITHMS: DitherAlgorithm[] = ['floyd', 'atkinson', 'ordered', 'threshold']

const DEFAULT_NAME = process.env.PRINTER_NAME || 'Thermal Printer'

/** Physical paper width (hundredths of mm) advertised over IPP, per print width. */
export function paperWidthHmm(dots: number): number {
	return dots <= 384 ? 5800 : 8000 // 58 mm vs 80 mm
}

const CONFIG_PATH = process.env.THERMAL_CONFIG_PATH || join(homedir(), '.thermal-print-config.json')

const newId = () => randomUUID().slice(0, 8)

/**
 * Build the printer list from a raw config object, migrating older shapes
 * (top-level printerIp/printerName/printerUuid, virtualPrinters[], saved
 * printers[{ip,name}]) into the unified list.
 */
export function migratePrinters(raw: Record<string, unknown>): { printers: NetworkPrinter[]; defaultPrinterId: string } {
	const list: NetworkPrinter[] = []
	const byIp = new Set<string>()
	let defaultId = ''

	const add = (id: string | undefined, name: unknown, ip: unknown, uuid: unknown): string | undefined => {
		if (typeof ip !== 'string' || !ip || byIp.has(ip)) return undefined
		byIp.add(ip)
		const printer: NetworkPrinter = {
			id: id || newId(),
			name: typeof name === 'string' && name.trim() ? name : DEFAULT_NAME,
			ip,
			uuid: typeof uuid === 'string' && uuid ? uuid : randomUUID(),
		}
		list.push(printer)
		return printer.id
	}

	// New-shape entries first (preserve ids/uuids).
	if (Array.isArray(raw.printers)) {
		for (const p of raw.printers) {
			if (p && typeof p.id === 'string' && typeof p.ip === 'string') add(p.id, p.name, p.ip, p.uuid)
		}
	}
	// Legacy primary.
	if (typeof raw.printerIp === 'string' && raw.printerIp) {
		const id = byIp.has(raw.printerIp)
			? list.find((p) => p.ip === raw.printerIp)?.id
			: add(newId(), raw.printerName, raw.printerIp, raw.printerUuid)
		if (id && !defaultId) defaultId = id
	}
	// Legacy virtual printers.
	if (Array.isArray(raw.virtualPrinters)) {
		for (const vp of raw.virtualPrinters) add(vp?.id, vp?.name, vp?.targetIp, vp?.uuid)
	}
	// Legacy saved printers ({ ip, name } without id).
	if (Array.isArray(raw.printers)) {
		for (const p of raw.printers) if (p && !p.id && typeof p.ip === 'string') add(undefined, p.name, p.ip, undefined)
	}
	// Fresh install seeded from env.
	if (list.length === 0 && process.env.PRINTER_IP) add(undefined, DEFAULT_NAME, process.env.PRINTER_IP, undefined)

	if (typeof raw.defaultPrinterId === 'string' && list.some((p) => p.id === raw.defaultPrinterId)) {
		defaultId = raw.defaultPrinterId
	}
	if (!defaultId) defaultId = list[0]?.id ?? ''
	return { printers: list, defaultPrinterId: defaultId }
}

let cache: Config | null = null

export function getConfig(): Config {
	if (cache) return cache
	let raw: Record<string, unknown> = {}
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
	} catch {
		/* no config yet */
	}
	const { printers, defaultPrinterId } = migratePrinters(raw)
	cache = {
		paperWidthDots: Number(raw.paperWidthDots) || Number(process.env.PAPER_WIDTH_DOTS) || 576,
		ditherAlgorithm: DITHER_ALGORITHMS.includes(raw.ditherAlgorithm as DitherAlgorithm)
			? (raw.ditherAlgorithm as DitherAlgorithm)
			: 'floyd',
		brightness: typeof raw.brightness === 'number' ? raw.brightness : 0,
		contrast: typeof raw.contrast === 'number' ? raw.contrast : 0,
		printers,
		defaultPrinterId,
	}
	// Persist the cleaned / migrated shape once.
	return setConfig({})
}

export function setConfig(patch: Partial<Config>): Config {
	const next = { ...getConfig(), ...patch }
	cache = next
	try {
		// Atomic write: write a temp file then rename, so a crash mid-write can't
		// leave a truncated / corrupt config.
		const tmp = `${CONFIG_PATH}.tmp`
		writeFileSync(tmp, JSON.stringify(next, null, 2))
		renameSync(tmp, CONFIG_PATH)
	} catch (err) {
		log.error(`Nepodařilo se uložit konfiguraci do ${CONFIG_PATH}:`, err)
	}
	return next
}

// --- Printer list operations -------------------------------------------------

export function getPrinters(): NetworkPrinter[] {
	return getConfig().printers
}

/** The default printer (the "star"), or the first one as a fallback. */
export function getDefaultPrinter(): NetworkPrinter | undefined {
	const cfg = getConfig()
	return cfg.printers.find((p) => p.id === cfg.defaultPrinterId) ?? cfg.printers[0]
}

export function addPrinter(name: string, ip: string): NetworkPrinter {
	const printer: NetworkPrinter = { id: newId(), name, ip, uuid: randomUUID() }
	const cfg = getConfig()
	const patch: Partial<Config> = { printers: [...cfg.printers, printer] }
	if (cfg.printers.length === 0) patch.defaultPrinterId = printer.id // first one becomes default
	setConfig(patch)
	return printer
}

export function updatePrinter(id: string, patch: Partial<Pick<NetworkPrinter, 'name' | 'ip'>>): NetworkPrinter[] {
	const printers = getConfig().printers.map((p) => (p.id === id ? { ...p, ...patch } : p))
	return setConfig({ printers }).printers
}

export function removePrinter(id: string): Config {
	const cfg = getConfig()
	const printers = cfg.printers.filter((p) => p.id !== id)
	const patch: Partial<Config> = { printers }
	if (cfg.defaultPrinterId === id) patch.defaultPrinterId = printers[0]?.id ?? ''
	return setConfig(patch)
}

export function setDefaultPrinter(id: string): Config {
	if (!getConfig().printers.some((p) => p.id === id)) return getConfig()
	return setConfig({ defaultPrinterId: id })
}

// --- Advertising -------------------------------------------------------------

/** All printers to advertise; the default takes the canonical `ipp/print` path. */
export function getAdvertisedPrinters(): AdvertisedPrinter[] {
	const def = getDefaultPrinter()
	return getPrinters().map((p) => ({
		name: p.name,
		uuid: p.uuid,
		targetIp: p.ip,
		resourcePath: p.id === def?.id ? 'ipp/print' : `ipp/print/${p.id}`,
		primary: p.id === def?.id,
	}))
}

/** Resolve an advertised printer from an IPP request path (falls back to default). */
export function resolveAdvertisedPrinter(path: string): AdvertisedPrinter {
	const rp = path.replace(/^\/+/, '')
	const all = getAdvertisedPrinters()
	return (
		all.find((p) => p.resourcePath === rp) ??
		all.find((p) => p.primary) ??
		all[0] ?? { name: DEFAULT_NAME, uuid: '', targetIp: '', resourcePath: 'ipp/print', primary: true }
	)
}
