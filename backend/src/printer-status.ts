/**
 * Tracks the configured thermal printer's status: whether it's reachable, online,
 * out of paper, or has its cover open. A background monitor keeps a cached value
 * so hot paths (IPP Get-Printer-Attributes, called frequently by the OS) can read
 * it synchronously.
 *
 * Status comes from ESC/POS real-time status requests (`DLE EOT n`), which are
 * safe — they never print. n=1 reports online/offline, n=2 the offline cause
 * (cover), n=4 the paper sensor.
 */
import { createConnection } from 'net'
import { getDefaultPrinter } from './config.js'

const PRINT_PORT = 9100

export interface PrinterStatus {
	ip: string
	reachable: boolean | null // null = not yet checked
	online: boolean
	paperOut: boolean
	coverOpen: boolean
	lastCheck: number
}

let status: PrinterStatus = { ip: '', reachable: null, online: false, paperOut: false, coverOpen: false, lastCheck: 0 }

/** Lightweight connect-only reachability check (used by the print queue). */
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

/** Connect and read ESC/POS real-time status (paper / cover / online). */
function probeStatus(ip: string): Promise<Omit<PrinterStatus, 'ip' | 'lastCheck'>> {
	return new Promise((resolve) => {
		const offline = { reachable: false, online: false, paperOut: false, coverOpen: false }
		if (!ip) return resolve(offline)
		const socket = createConnection({ host: ip, port: PRINT_PORT })
		let settled = false
		const bytes: number[] = []
		let readTimer: ReturnType<typeof setTimeout> | undefined
		const finish = (reachable: boolean) => {
			if (settled) return
			settled = true
			if (readTimer) clearTimeout(readTimer)
			socket.destroy()
			if (!reachable) return resolve(offline)
			const b0 = bytes[0]
			const b1 = bytes[1]
			const b2 = bytes[2]
			resolve({
				reachable: true,
				online: b0 === undefined ? true : (b0 & 0x08) === 0, // n=1 bit3 = offline
				coverOpen: b1 === undefined ? false : (b1 & 0x04) !== 0, // n=2 bit2 = cover open
				paperOut: b2 === undefined ? false : (b2 & 0x60) === 0x60, // n=4 bits5,6 = paper end
			})
		}
		socket.setTimeout(1000)
		socket.once('connect', () => {
			try {
				socket.write(Buffer.from([0x10, 0x04, 0x01, 0x10, 0x04, 0x02, 0x10, 0x04, 0x04]))
			} catch {
				/* ignore */
			}
			readTimer = setTimeout(() => finish(true), 450)
		})
		socket.on('data', (d) => {
			for (const b of d) bytes.push(b)
			if (bytes.length >= 3) finish(true)
		})
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

export async function refreshPrinterStatus(): Promise<PrinterStatus> {
	const ip = getDefaultPrinter()?.ip ?? ''
	const s = await probeStatus(ip)
	// Ignore a stale result if the default printer changed while we were probing.
	if ((getDefaultPrinter()?.ip ?? '') !== ip) return status
	status = { ip, ...s, lastCheck: Date.now() }
	return status
}

export function getPrinterStatus(): PrinterStatus {
	// Keep the reported IP in sync even before the first probe.
	return { ...status, ip: getDefaultPrinter()?.ip ?? '' }
}

export function startPrinterMonitor(intervalMs = 20_000): NodeJS.Timeout {
	void refreshPrinterStatus()
	const timer = setInterval(() => void refreshPrinterStatus(), intervalMs)
	timer.unref?.()
	return timer
}
