import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Small persisted config. Unlike the web flow (where the target printer IP comes
 * from the form on every request), driverless IPP jobs arrive with no IP, so the
 * destination thermal printer must be configured once and remembered.
 */
export interface Config {
	/** IP of the physical ESC/POS thermal printer to forward jobs to. */
	printerIp: string
	/** Name advertised on the network for the virtual driverless printer. */
	printerName: string
	/** Stable UUID advertised over IPP so clients recognise the same printer. */
	printerUuid: string
}

const CONFIG_PATH = process.env.THERMAL_CONFIG_PATH || join(homedir(), '.thermal-print-config.json')

const defaults: Config = {
	printerIp: process.env.PRINTER_IP || '',
	printerName: process.env.PRINTER_NAME || 'Thermal Printer',
	printerUuid: '',
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
