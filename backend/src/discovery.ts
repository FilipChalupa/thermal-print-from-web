/**
 * Discovery of nearby ESC/POS thermal printers so the UI can suggest IP
 * addresses. Two complementary strategies:
 *   1. mDNS/DNS-SD browse for `_pdl-datastream._tcp` (raw port-9100 printing) —
 *      catches printers that advertise themselves, with a friendly name.
 *   2. An active sweep of the local /24 on TCP port 9100 — catches the many cheap
 *      thermal printers that only have a static IP and an open raw-print port.
 * Results are merged and de-duplicated by IP.
 */
import { Bonjour } from 'bonjour-service'
import { createConnection } from 'net'
import { networkInterfaces } from 'os'

export interface DiscoveredPrinter {
	ip: string
	name?: string
	port: number
	source: 'mdns' | 'scan'
	/** True when the host confirmed it speaks ESC/POS (mDNS raw-print or status reply). */
	verified?: boolean
}

type OnFound = (printer: DiscoveredPrinter) => void

const PRINT_PORT = 9100
const CONNECT_TIMEOUT_MS = 400
const ESCPOS_PROBE_MS = 350 // window to wait for an ESC/POS status reply
const SCAN_CONCURRENCY = 64
const MDNS_BROWSE_MS = 2000
const MAX_HOSTS = 1024 // safety cap so we never sweep a huge subnet

function ipToInt(ip: string): number {
	return ip.split('.').reduce((acc, part) => (acc << 8) + (parseInt(part, 10) & 0xff), 0) >>> 0
}

function intToIp(n: number): string {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

/** All host IPs on our directly-connected IPv4 subnets (excluding our own). */
function candidateIps(): string[] {
	// Explicit override, e.g. for unusual networks or when auto-detection picks
	// the wrong interface: THERMAL_DISCOVERY_HOSTS="192.168.1.10,192.168.1.11"
	const override = process.env.THERMAL_DISCOVERY_HOSTS
	if (override) {
		return override
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	}

	const hosts = new Set<string>()
	const own = new Set<string>()

	for (const addrs of Object.values(networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family !== 'IPv4' || a.internal) continue
			own.add(a.address)
			const ip = ipToInt(a.address)
			const mask = ipToInt(a.netmask)
			const network = (ip & mask) >>> 0
			const broadcast = (network | (~mask >>> 0)) >>> 0
			for (let h = network + 1; h < broadcast && hosts.size < MAX_HOSTS; h++) {
				hosts.add(intToIp(h))
			}
		}
	}

	for (const self of own) hosts.delete(self)
	return [...hosts]
}

/**
 * Probe a host on port 9100: is it open, and does it speak ESC/POS? We connect
 * and send a real-time status request (`DLE EOT 1` — safe, never prints); a real
 * ESC/POS printer replies with a status byte, which filters out other services
 * that merely happen to have 9100 open.
 */
function probe(ip: string): Promise<{ open: boolean; escpos: boolean }> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: ip, port: PRINT_PORT })
		let settled = false
		let escpos = false
		let replyTimer: ReturnType<typeof setTimeout> | undefined
		const finish = (open: boolean) => {
			if (settled) return
			settled = true
			if (replyTimer) clearTimeout(replyTimer)
			socket.destroy()
			resolve({ open, escpos })
		}
		socket.setTimeout(CONNECT_TIMEOUT_MS)
		socket.once('connect', () => {
			try {
				socket.write(Buffer.from([0x10, 0x04, 0x01])) // DLE EOT 1 — transmit status
			} catch {
				/* ignore */
			}
			replyTimer = setTimeout(() => finish(true), ESCPOS_PROBE_MS)
		})
		socket.once('data', () => {
			escpos = true
			finish(true)
		})
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

/** Run `probe` over all candidates with a bounded worker pool. */
async function scanPort9100(onFound?: OnFound): Promise<DiscoveredPrinter[]> {
	const ips = candidateIps()
	const found: DiscoveredPrinter[] = []
	let cursor = 0

	async function worker() {
		while (cursor < ips.length) {
			const ip = ips[cursor++]
			const { open, escpos } = await probe(ip)
			if (open) {
				const printer: DiscoveredPrinter = { ip, port: PRINT_PORT, source: 'scan', verified: escpos }
				found.push(printer)
				onFound?.(printer)
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ips.length) }, worker))
	return found
}

function browseMdns(onFound?: OnFound): Promise<DiscoveredPrinter[]> {
	return new Promise((resolve) => {
		const found: DiscoveredPrinter[] = []
		let bonjour: Bonjour
		try {
			bonjour = new Bonjour()
		} catch {
			resolve(found)
			return
		}
		const browser = bonjour.find({ type: 'pdl-datastream' }, (service) => {
			const ip = service.addresses?.find((a) => a.includes('.'))
			if (ip) {
				const printer: DiscoveredPrinter = { ip, name: service.name, port: service.port || PRINT_PORT, source: 'mdns', verified: true }
				found.push(printer)
				onFound?.(printer)
			}
		})
		setTimeout(() => {
			try {
				browser.stop()
				bonjour.destroy()
			} catch {
				/* ignore */
			}
			resolve(found)
		}, MDNS_BROWSE_MS)
	})
}

/**
 * Choose the best default among discovered printers: prefer one that advertised
 * itself over mDNS (almost certainly a real printer, and it carries a name) over
 * a bare open-9100 host from the sweep.
 */
export function pickDefaultPrinter(printers: DiscoveredPrinter[]): DiscoveredPrinter | undefined {
	return printers.find((p) => p.source === 'mdns') ?? printers[0]
}

let cache: { at: number; result: DiscoveredPrinter[] } | null = null
const CACHE_MS = 8000

/** Discover thermal printers on the LAN. Results are cached briefly. */
export async function discoverPrinters(): Promise<DiscoveredPrinter[]> {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.result

	const [mdns, scan] = await Promise.all([browseMdns(), scanPort9100()])

	// Merge, preferring the mDNS entry (it carries a name) on IP collisions.
	const byIp = new Map<string, DiscoveredPrinter>()
	for (const p of scan) byIp.set(p.ip, p)
	for (const p of mdns) byIp.set(p.ip, { ...byIp.get(p.ip), ...p })

	const result = [...byIp.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip))
	cache = { at: Date.now(), result }
	return result
}

/**
 * Streaming discovery: invokes `onFound` for each printer as soon as it is seen
 * (mDNS hits appear instantly, scan hits trickle in), then resolves when done.
 * Used to power live suggestions in the UI. Not cached.
 */
export async function discoverPrintersStream(onFound: OnFound): Promise<void> {
	await Promise.all([browseMdns(onFound), scanPort9100(onFound)])
}
