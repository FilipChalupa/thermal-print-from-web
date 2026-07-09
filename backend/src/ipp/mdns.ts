/**
 * Advertise the virtual printer on the local network via mDNS/DNS-SD so that
 * macOS (AirPrint), Windows (IPP Everywhere / Mopria) and Linux (CUPS driverless)
 * discover it with no driver install. The TXT records mirror the capabilities the
 * IPP server reports from Get-Printer-Attributes.
 */
import { Bonjour, Service } from 'bonjour-service'
import { getConfig } from '../config.js'
import { MAKE_AND_MODEL, PDL_SUPPORTED, URF_SUPPORTED } from './server.js'

export interface MdnsHandle {
	stop: () => Promise<void>
}

export function startMdns(options: { port: number; resourcePath?: string }): MdnsHandle {
	const cfg = getConfig()
	const rp = options.resourcePath ?? 'ipp/print'

	const txt: Record<string, string> = {
		txtvers: '1',
		qtotal: '1',
		rp,
		ty: MAKE_AND_MODEL,
		product: `(${cfg.printerName})`,
		note: '',
		pdl: PDL_SUPPORTED.join(','),
		URF: URF_SUPPORTED.join(','),
		UUID: cfg.printerUuid,
		Color: 'F',
		Duplex: 'F',
		TLS: '',
		Transparent: 'T',
		Binary: 'T',
		Fax: 'F',
		Scan: 'F',
		// AirPrint hints
		air: 'none',
		mopria: 'certified',
		priority: '50',
	}

	const bonjour = new Bonjour()
	// `_universal._sub._ipp._tcp` is the AirPrint discovery subtype.
	const service: Service = bonjour.publish({
		name: cfg.printerName,
		type: 'ipp',
		protocol: 'tcp',
		port: options.port,
		txt,
		subtypes: ['universal'],
	})

	service.on('error', (err) => console.error('mDNS advertising error:', err))
	console.log(`mDNS: advertising "${cfg.printerName}" as _ipp._tcp on port ${options.port}`)

	return {
		stop: () =>
			new Promise<void>((resolve) => {
				bonjour.unpublishAll(() => {
					bonjour.destroy()
					resolve()
				})
			}),
	}
}
