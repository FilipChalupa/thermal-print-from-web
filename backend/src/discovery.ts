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
}

const PRINT_PORT = 9100
const CONNECT_TIMEOUT_MS = 400
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

function probe(ip: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: ip, port })
		let settled = false
		const finish = (ok: boolean) => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(ok)
		}
		socket.setTimeout(CONNECT_TIMEOUT_MS)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

/** Run `probe` over all candidates with a bounded worker pool. */
async function scanPort9100(): Promise<DiscoveredPrinter[]> {
	const ips = candidateIps()
	const found: DiscoveredPrinter[] = []
	let cursor = 0

	async function worker() {
		while (cursor < ips.length) {
			const ip = ips[cursor++]
			if (await probe(ip, PRINT_PORT)) {
				found.push({ ip, port: PRINT_PORT, source: 'scan' })
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ips.length) }, worker))
	return found
}

function browseMdns(): Promise<DiscoveredPrinter[]> {
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
			if (ip) found.push({ ip, name: service.name, port: service.port || PRINT_PORT, source: 'mdns' })
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
