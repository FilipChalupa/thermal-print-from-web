// Runs as the npm "version" lifecycle script: copies the freshly bumped
// root version into desktop/package.json so installers get the same version.
import { readFileSync, writeFileSync } from 'fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

for (const file of ['desktop/package.json', 'desktop/package-lock.json']) {
	const content = readFileSync(file, 'utf8')
	const indent = content.includes('\n\t') ? '\t' : '  '
	const json = JSON.parse(content)
	json.version = version
	if (json.packages?.['']) {
		json.packages[''].version = version
	}
	writeFileSync(file, JSON.stringify(json, null, indent) + '\n')
}
