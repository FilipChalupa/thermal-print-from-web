/**
 * LAN-facing HTTP listener that speaks IPP. It is deliberately separate from the
 * Hono web UI server: the UI stays on loopback, while this must bind to all
 * interfaces so other machines on the network can reach the virtual printer.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { resolveAdvertisedPrinter } from '../config.js'
import { handleIppRequest } from './server.js'

export interface IppHttpHandle {
	port: number
	close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on('data', (c) => chunks.push(c))
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method !== 'POST') {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('Thermal virtual printer (IPP endpoint). POST application/ipp here.')
		return
	}

	try {
		const body = await readBody(req)
		const host = req.headers.host ?? 'localhost'
		const path = req.url || '/ipp/print'
		const printer = resolveAdvertisedPrinter(path)
		const printerUri = `ipp://${host}/${printer.resourcePath}`
		const responseBuffer = await handleIppRequest(body, { printerUri, printer })
		res.writeHead(200, { 'Content-Type': 'application/ipp' })
		res.end(responseBuffer)
	} catch (err) {
		console.error('IPP request handling failed:', err)
		res.writeHead(500)
		res.end()
	}
}

export function startIppHttpServer(options: { port: number; hostname?: string }): Promise<IppHttpHandle> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => void onRequest(req, res))
		server.on('error', reject)
		server.listen(options.port, options.hostname ?? '0.0.0.0', () => {
			const port = (server.address() as AddressInfo).port
			console.log(`IPP server listening on ${options.hostname ?? '0.0.0.0'}:${port}`)
			resolve({
				port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			})
		})
	})
}
