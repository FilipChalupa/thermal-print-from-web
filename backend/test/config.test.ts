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

	it('mints and persists a stable UUID', () => {
		const uuid = cfg.getConfig().printerUuid
		expect(uuid).toMatch(/[0-9a-f-]{36}/)
		expect(cfg.getConfig().printerUuid).toBe(uuid) // stable across calls
	})

	it('upserts and removes saved printers, keyed by IP', () => {
		cfg.upsertPrinter('10.0.0.5', 'Kuchyně')
		cfg.upsertPrinter('10.0.0.9', 'Bar')
		expect(cfg.getConfig().printers.map((p) => p.ip).sort()).toEqual(['10.0.0.5', '10.0.0.9'])

		// Upsert same IP renames rather than duplicates.
		cfg.upsertPrinter('10.0.0.5', 'Kuchyně 2')
		const kitchen = cfg.getConfig().printers.filter((p) => p.ip === '10.0.0.5')
		expect(kitchen).toHaveLength(1)
		expect(kitchen[0].name).toBe('Kuchyně 2')

		cfg.removePrinter('10.0.0.5')
		expect(cfg.getConfig().printers.map((p) => p.ip)).toEqual(['10.0.0.9'])
	})

	it('persists changes to disk', () => {
		cfg.setConfig({ paperWidthDots: 384, brightness: 20 })
		expect(cfg.getConfig().paperWidthDots).toBe(384)
		expect(cfg.getConfig().brightness).toBe(20)
	})
})
