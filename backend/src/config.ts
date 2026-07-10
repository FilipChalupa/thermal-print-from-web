import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Small persisted config. Unlike the web flow (where the target printer IP comes
 * from the form on every request), driverless IPP jobs arrive with no IP, so the
 * destination thermal printer must be configured once and remembered.
 */
export interface SavedPrinter {
	ip: string
	name: string
}

/** An additional driverless queue mapped to another physical printer. */
export interface VirtualPrinter {
	id: string
	name: string
	targetIp: string
	uuid: string
}

/** A printer advertised over mDNS + IPP (the primary one plus any extras). */
export interface AdvertisedPrinter {
	name: string
	uuid: string
	targetIp: string
	resourcePath: string
	primary: boolean
}

export interface Config {
	/** IP of the physical ESC/POS thermal printer to forward jobs to. */
	printerIp: string
	/** Name advertised on the network for the virtual driverless printer. */
	printerName: string
	/** Stable UUID advertised over IPP so clients recognise the same printer. */
	printerUuid: string
	/** Print width in dots: 576 for 80 mm paper, 384 for 58 mm (both @ 203 dpi). */
	paperWidthDots: number
	/** User-saved / renamed printers, kept across reloads even if not rediscovered. */
	printers: SavedPrinter[]
	/** Halftoning algorithm applied when converting images to 1-bit. */
	ditherAlgorithm: DitherAlgorithm
	/** Brightness adjustment, -100…100 (applied before dithering). */
	brightness: number
	/** Contrast adjustment, -100…100 (applied before dithering). */
	contrast: number
	/** Additional driverless queues, each mapped to another physical printer. */
	virtualPrinters: VirtualPrinter[]
}

export type DitherAlgorithm = 'floyd' | 'atkinson' | 'ordered' | 'threshold'
export const DITHER_ALGORITHMS: DitherAlgorithm[] = ['floyd', 'atkinson', 'ordered', 'threshold']

/** Physical paper width (hundredths of mm) advertised over IPP, per print width. */
export function paperWidthHmm(dots: number): number {
	return dots <= 384 ? 5800 : 8000 // 58 mm vs 80 mm
}

const CONFIG_PATH = process.env.THERMAL_CONFIG_PATH || join(homedir(), '.thermal-print-config.json')

const defaults: Config = {
	printerIp: process.env.PRINTER_IP || '',
	printerName: process.env.PRINTER_NAME || 'Thermal Printer',
	printerUuid: '',
	paperWidthDots: Number(process.env.PAPER_WIDTH_DOTS) || 576,
	printers: [],
	ditherAlgorithm: 'floyd',
	brightness: 0,
	contrast: 0,
	virtualPrinters: [],
}

let cache: Config | null = null

export function getConfig(): Config {
	if (cache) return cache
	let loaded: Config
	try {
		loaded = { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }
	} catch {
		loaded = { ...defaults }
	}
	cache = loaded
	// Mint and persist a stable UUID on first run.
	if (!loaded.printerUuid) return setConfig({ printerUuid: randomUUID() })
	return loaded
}

export function setConfig(patch: Partial<Config>): Config {
	const next = { ...getConfig(), ...patch }
	cache = next
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
	} catch (err) {
		console.error(`Nepodařilo se uložit konfiguraci do ${CONFIG_PATH}:`, err)
	}
	return next
}

/** Add or rename a saved printer (keyed by IP). */
export function upsertPrinter(ip: string, name: string): SavedPrinter[] {
	const printers = getConfig().printers.filter((p) => p.ip !== ip)
	printers.push({ ip, name })
	printers.sort((a, b) => a.name.localeCompare(b.name))
	return setConfig({ printers }).printers
}

export function removePrinter(ip: string): SavedPrinter[] {
	return setConfig({ printers: getConfig().printers.filter((p) => p.ip !== ip) }).printers
}

/** All printers to advertise: the primary (from the top-level fields) plus extras. */
export function getAdvertisedPrinters(): AdvertisedPrinter[] {
	const cfg = getConfig()
	const primary: AdvertisedPrinter = {
		name: cfg.printerName,
		uuid: cfg.printerUuid,
		targetIp: cfg.printerIp,
		resourcePath: 'ipp/print',
		primary: true,
	}
	const extras = cfg.virtualPrinters.map((p) => ({
		name: p.name,
		uuid: p.uuid,
		targetIp: p.targetIp,
		resourcePath: `ipp/print/${p.id}`,
		primary: false,
	}))
	return [primary, ...extras]
}

/** Resolve an advertised printer from an IPP request path (falls back to primary). */
export function resolveAdvertisedPrinter(path: string): AdvertisedPrinter {
	const rp = path.replace(/^\/+/, '')
	const all = getAdvertisedPrinters()
	return all.find((p) => p.resourcePath === rp) ?? all[0]
}

export function addVirtualPrinter(name: string, targetIp: string): VirtualPrinter[] {
	const printer: VirtualPrinter = { id: randomUUID().slice(0, 8), name, targetIp, uuid: randomUUID() }
	return setConfig({ virtualPrinters: [...getConfig().virtualPrinters, printer] }).virtualPrinters
}

export function updateVirtualPrinter(id: string, patch: Partial<Pick<VirtualPrinter, 'name' | 'targetIp'>>): VirtualPrinter[] {
	const virtualPrinters = getConfig().virtualPrinters.map((p) => (p.id === id ? { ...p, ...patch } : p))
	return setConfig({ virtualPrinters }).virtualPrinters
}

export function removeVirtualPrinter(id: string): VirtualPrinter[] {
	return setConfig({ virtualPrinters: getConfig().virtualPrinters.filter((p) => p.id !== id) }).virtualPrinters
}
