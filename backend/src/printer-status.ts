/**
 * Tracks whether the configured thermal printer is currently reachable on its
 * raw-print port. A background monitor keeps a cached value so hot paths (IPP
 * Get-Printer-Attributes, called frequently by the OS) can read it synchronously
 * instead of doing a blocking TCP connect each time.
 */
import { createConnection } from 'net'
import { getConfig } from './config.js'

const PRINT_PORT = 9100

let reachable: boolean | null = null // null = not yet checked
let lastCheck = 0

/** One-shot TCP reachability check of a host's raw-print port. */
export function tcpReachable(ip: string, timeoutMs = 800): Promise<boolean> {
	return new Promise((resolve) => {
		if (!ip) return resolve(false)
		const socket = createConnection({ host: ip, port: PRINT_PORT })
		let settled = false
		const finish = (ok: boolean) => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(ok)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

export async function refreshPrinterStatus(): Promise<boolean> {
	const ip = getConfig().printerIp
	reachable = ip ? await tcpReachable(ip) : false
	lastCheck = Date.now()
	return reachable
}

export function getPrinterStatus(): { ip: string; reachable: boolean | null; lastCheck: number } {
	return { ip: getConfig().printerIp, reachable, lastCheck }
}

export function startPrinterMonitor(intervalMs = 20_000): NodeJS.Timeout {
	void refreshPrinterStatus()
	const timer = setInterval(() => void refreshPrinterStatus(), intervalMs)
	timer.unref?.()
	return timer
}
