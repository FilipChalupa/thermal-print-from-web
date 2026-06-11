// electron-builder afterPack hook: macOS vyžaduje na Apple Siliconu platný
// (aspoň ad-hoc) podpis celého bundlu, jinak appku odmítne jako "damaged".
// Bez Apple Developer certifikátu podepisujeme ad-hoc identitou "-".
const { execSync } = require('child_process')
const path = require('path')

module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== 'darwin') {
		return
	}
	const appName = context.packager.appInfo.productFilename
	const appPath = path.join(context.appOutDir, `${appName}.app`)
	execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
	execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
}
