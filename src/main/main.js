'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { CHANNELS } = require('../shared/channels');
const { JobManager } = require('./job-manager');
const { UpdaterService } = require('./updater');
const configService = require('./config-service');

/**
 * Stats a chosen file, returning its size in bytes. Unreadable files fall back
 * to size 0 so the picker still lists them (the loader will surface a real error
 * at import time).
 *
 * @param {string} filePath
 * @returns {Promise.<{ path: string, size: number }>}
 */
async function toSizedFile(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return { path: filePath, size: stats.size };
    } catch {
        return { path: filePath, size: 0 };
    }
}

/**
 * Mutable app state. Held on a const object so helper functions can update the
 * current window reference without reassigning a top-level binding.
 *
 * @type {{
 *   mainWindow: BrowserWindow | undefined,
 *   jobManager: JobManager | undefined,
 *   updater: UpdaterService | undefined,
 * }}
 */
const state = { mainWindow: undefined, jobManager: undefined, updater: undefined };

const isDevelopment = !app.isPackaged;

/**
 * Creates the single application window with a hardened, sandboxed renderer.
 *
 * @returns {void}
 */
function createWindow() {
    const win = new BrowserWindow({
        width: 1024,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        show: false,
        backgroundColor: '#1e1e1e',
        title: 'SFMC Data Loader',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    state.mainWindow = win;

    win.removeMenu();
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    win.once('ready-to-show', () => {
        win.show();
        if (isDevelopment) {
            win.webContents.openDevTools({ mode: 'detach' });
        }
    });

    win.on('closed', () => {
        state.mainWindow = undefined;
    });
}

/**
 * Focuses the existing window when a second instance is launched.
 *
 * @returns {void}
 */
function focusExistingWindow() {
    const win = state.mainWindow;
    if (!win) {
        return;
    }
    if (win.isMinimized()) {
        win.restore();
    }
    win.focus();
}

/**
 * Registers all IPC handlers: `ipcMain.handle` request/response endpoints plus
 * the fire-and-forget job start/cancel channels.
 *
 * @returns {void}
 */
function registerIpcHandlers() {
    ipcMain.handle(CHANNELS.APP_INFO, () => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        chromeVersion: process.versions.chrome,
        platform: process.platform,
        userDataPath: app.getPath('userData'),
    }));

    ipcMain.handle(CHANNELS.DIALOG_OPEN_DIRECTORY, async () => {
        const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
            properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
    });

    ipcMain.handle(CHANNELS.DIALOG_OPEN_FILES, async (_event, options) => {
        const filters =
            options && Array.isArray(options.extensions) && options.extensions.length > 0
                ? [{ name: 'Files', extensions: options.extensions }]
                : undefined;
        const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
            properties: ['openFile', 'multiSelections'],
            filters,
        });
        if (result.canceled) {
            return [];
        }
        return Promise.all(result.filePaths.map((filePath) => toSizedFile(filePath)));
    });

    ipcMain.handle(CHANNELS.OPEN_PATH, (_event, targetPath) => shell.openPath(targetPath));

    ipcMain.handle(CHANNELS.CONFIG_LOAD, (_event, projectRoot) =>
        configService.loadConfig(projectRoot),
    );
    ipcMain.handle(CHANNELS.CONFIG_FETCH_DE_LIST, (_event, payload) =>
        configService.fetchDeList(payload),
    );

    ipcMain.handle(CHANNELS.JOB_START, (_event, job) => state.jobManager.start(job));
    ipcMain.handle(CHANNELS.JOB_CANCEL, (_event, jobId) => state.jobManager.cancel(jobId));

    ipcMain.handle(CHANNELS.UPDATE_CHECK, () => state.updater?.checkForUpdates());
    ipcMain.handle(CHANNELS.UPDATE_INSTALL, () => state.updater?.quitAndInstall() ?? false);
}

/**
 * Boots the app once Electron is ready.
 *
 * @returns {Promise.<void>}
 */
async function bootstrap() {
    await app.whenReady();
    const getWebContents = () => (state.mainWindow ? state.mainWindow.webContents : undefined);
    state.jobManager = new JobManager(getWebContents);
    state.updater = new UpdaterService(getWebContents, { isPackaged: app.isPackaged });
    registerIpcHandlers();
    createWindow();

    // Check for updates shortly after launch so the check never delays the
    // first paint. No-ops automatically in a dev/unpackaged build.
    setTimeout(() => {
        state.updater?.checkForUpdates();
    }, 3000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
}

// Single-instance lock — a data-loader should not run twice against the same project.
if (app.requestSingleInstanceLock()) {
    app.on('second-instance', focusExistingWindow);
    bootstrap();
} else {
    app.quit();
}

app.on('before-quit', () => {
    state.jobManager?.cancelAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
