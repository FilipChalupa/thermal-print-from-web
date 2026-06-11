import { cpSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const copies = [
	['../backend/dist', 'server'],
	['../frontend/dist', 'public'],
]

for (const [from, to] of copies) {
	const target = join(desktopDir, to)
	rmSync(target, { recursive: true, force: true })
	cpSync(join(desktopDir, from), target, { recursive: true })
}
