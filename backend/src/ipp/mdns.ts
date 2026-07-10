/**
 * Advertise the virtual printer on the local network via mDNS/DNS-SD so that
 * macOS (AirPrint), Windows (IPP Everywhere / Mopria) and Linux (CUPS driverless)
 * discover it with no driver install. The TXT records mirror the capabilities the
 * IPP server reports from Get-Printer-Attributes.
 */
import { Bonjour } from 'bonjour-service'
import { getAdvertisedPrinters } from '../config.js'
import { MAKE_AND_MODEL, PDL_SUPPORTED, URF_SUPPORTED } from './server.js'

export interface MdnsHandle {
	stop: () => Promise<void>
}

export function startMdns(options: { port: number }): MdnsHandle {
	const bonjour = new Bonjour()

	// One `_ipp._tcp` service per advertised printer (primary + extra queues),
	// each on its own resource path so the OS treats them as distinct printers.
	for (const printer of getAdvertisedPrinters()) {
		const txt: Record<string, string> = {
			txtvers: '1',
			qtotal: '1',
			rp: printer.resourcePath,
			ty: MAKE_AND_MODEL,
			product: `(${printer.name})`,
			note: '',
			pdl: PDL_SUPPORTED.join(','),
			URF: URF_SUPPORTED.join(','),
			UUID: printer.uuid,
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
		// `_universal._sub._ipp._tcp` is the AirPrint discovery subtype.
		const service = bonjour.publish({
			name: printer.name,
			type: 'ipp',
			protocol: 'tcp',
			port: options.port,
			txt,
			subtypes: ['universal'],
		})
		service.on('error', (err) => console.error('mDNS advertising error:', err))
		console.log(`mDNS: advertising "${printer.name}" (/${printer.resourcePath}) as _ipp._tcp on port ${options.port}`)
	}

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
