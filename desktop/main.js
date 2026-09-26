'use strict';

/**
 * didahSDR desktop shell.
 *
 * Serves app/ on 127.0.0.1. Replay uses the public server; the Python
 * replay server and the recordings are not in the package. A browser opened
 * from the local server still uses ws://localhost:9000/ws on its own.
 */

const path = require('path');
const { app, BrowserWindow, Menu, session } = require('electron');
const { listen } = require('./static_server');

const DEVICE_PERMISSIONS = new Set(['media', 'usb', 'serial', 'hid']);
/** IQ WebSocket for the replay source inside the desktop window. */
const REPLAY_WS = 'wss://didahsdr.guenael.ca/ws';

function pageUrl(port) {
    return `http://127.0.0.1:${port}/?ws=${encodeURIComponent(REPLAY_WS)}`;
}

function appDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'app');
    return path.join(__dirname, '..', 'app');
}

function allowDevices() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(DEVICE_PERMISSIONS.has(permission));
    });
    ses.setPermissionCheckHandler((webContents, permission) => DEVICE_PERMISSIONS.has(permission));
    ses.setDevicePermissionHandler((details) => {
        return details.deviceType === 'usb' || details.deviceType === 'serial' || details.deviceType === 'hid';
    });
}

function createWindow(port) {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0b0d13',
        show: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    win.removeMenu();
    win.once('ready-to-show', () => {
        win.maximize();
        win.show();
    });
    win.loadURL(pageUrl(port));
    if (process.env.DIDAH_SMOKE) {
        win.webContents.on('did-finish-load', () => {
            win.webContents.executeJavaScript(`({
                replayChecked: !!document.querySelector('input[name="iq-source"][value="replay_server"]')?.checked,
                ws: new URLSearchParams(location.search).get('ws'),
                isolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
            })`).then((info) => {
                console.log('DIDAH_SMOKE ' + JSON.stringify(info));
                const ok = info.replayChecked && info.ws === REPLAY_WS && info.isolated;
                app.exit(ok ? 0 : 1);
            }).catch((err) => {
                console.error(err);
                app.exit(1);
            });
        });
    }
    return win;
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let server = null;

    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    app.whenReady().then(async () => {
        Menu.setApplicationMenu(null);
        allowDevices();
        server = await listen(appDir());
        const { port } = server.address();
        console.log('didahSDR desktop ' + pageUrl(port));
        createWindow(port);
    }).catch((err) => {
        console.error(err);
        app.exit(1);
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => { if (server) server.close(); });
}
