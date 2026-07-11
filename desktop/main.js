import { app, BrowserWindow } from 'electron'
import { startServer } from './server/index.js'

let port

const createWindow = () => {
	const window = new BrowserWindow({
		width: 1100,
		height: 800,
		autoHideMenuBar: true,
	})
	window.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(async () => {
	// Loopback only — the server is not reachable from other machines.
	// Port 0 lets the OS pick a free port so we never collide with anything.
	// ipp:false — desktop app is a local UI; must NOT advertise as a network printer.
	;({ port } = await startServer({ port: 0, hostname: '127.0.0.1', ipp: false }))
	createWindow()

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow()
		}
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})
