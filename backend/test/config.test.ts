import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

// Isolate this file's config on its own temp path (set before importing config).
let cfg: typeof import('../src/config.js')
beforeAll(async () => {
	process.env.THERMAL_CONFIG_PATH = join(tmpdir(), `cfg-test-${Math.random().toString(36).slice(2)}.json`)
	cfg = await import('../src/config.js')
})

describe('config', () => {
	it('maps print width to physical paper width', () => {
		expect(cfg.paperWidthHmm(576)).toBe(8000) // 80 mm
		expect(cfg.paperWidthHmm(384)).toBe(5800) // 58 mm
	})

	it('adds printers, keeps the first as default, and mints stable UUIDs', () => {
		cfg.setConfig({ printers: [], defaultPrinterId: '' })
		const first = cfg.addPrinter('Kuchyně', '10.0.0.5')
		const second = cfg.addPrinter('Bar', '10.0.0.9')
		expect(first.uuid).toMatch(/[0-9a-f-]{36}/)
		expect(cfg.getDefaultPrinter()?.id).toBe(first.id) // first one is default
		expect(cfg.getConfig().printers.map((p) => p.ip)).toEqual(['10.0.0.5', '10.0.0.9'])

		// Renaming keeps id + uuid.
		cfg.updatePrinter(first.id, { name: 'Kuchyně 2' })
		const renamed = cfg.getPrinters().find((p) => p.id === first.id)!
		expect(renamed.name).toBe('Kuchyně 2')
		expect(renamed.uuid).toBe(first.uuid)

		// Removing the default promotes the next printer.
		cfg.removePrinter(first.id)
		expect(cfg.getPrinters().map((p) => p.ip)).toEqual(['10.0.0.9'])
		expect(cfg.getDefaultPrinter()?.id).toBe(second.id)
	})

	it('persists changes to disk', () => {
		cfg.setConfig({ paperWidthDots: 384, brightness: 20 })
		expect(cfg.getConfig().paperWidthDots).toBe(384)
		expect(cfg.getConfig().brightness).toBe(20)
	})

	it('advertises the default on the canonical path and others on /<id>', () => {
		cfg.setConfig({ printers: [], defaultPrinterId: '' })
		const primary = cfg.addPrinter('Primary', '10.0.0.1')
		const bar = cfg.addPrinter('Bar', '10.0.0.2')

		const advertised = cfg.getAdvertisedPrinters()
		expect(advertised.find((p) => p.targetIp === '10.0.0.1')).toMatchObject({ resourcePath: 'ipp/print', primary: true })
		expect(advertised.find((p) => p.targetIp === '10.0.0.2')).toMatchObject({ resourcePath: `ipp/print/${bar.id}`, primary: false })

		expect(cfg.resolveAdvertisedPrinter(`/ipp/print/${bar.id}`).targetIp).toBe('10.0.0.2')
		expect(cfg.resolveAdvertisedPrinter('/ipp/print').primary).toBe(true)
		expect(cfg.resolveAdvertisedPrinter('/unknown').primary).toBe(true) // falls back to default

		// Changing the default moves the canonical path.
		cfg.setDefaultPrinter(bar.id)
		expect(cfg.resolveAdvertisedPrinter('/ipp/print').targetIp).toBe('10.0.0.2')
		expect(cfg.getAdvertisedPrinters().find((p) => p.targetIp === '10.0.0.1')?.resourcePath).toBe(`ipp/print/${primary.id}`)
	})

	it('migrates a legacy config (printerIp + virtualPrinters + saved) into one list', () => {
		const { printers, defaultPrinterId } = cfg.migratePrinters({
			printerIp: '10.0.0.1',
			printerName: 'Hlavní',
			printerUuid: 'uuid-primary',
			virtualPrinters: [{ id: 'v1', name: 'Bar', targetIp: '10.0.0.2', uuid: 'uuid-bar' }],
			printers: [{ ip: '10.0.0.3', name: 'Sklad' }],
		})
		expect(printers.map((p) => p.ip).sort()).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3'])
		const def = printers.find((p) => p.id === defaultPrinterId)!
		expect(def.ip).toBe('10.0.0.1') // legacy primary becomes default
		expect(def.uuid).toBe('uuid-primary') // uuid preserved
		expect(printers.find((p) => p.ip === '10.0.0.2')?.uuid).toBe('uuid-bar') // virtual uuid preserved
	})
})
