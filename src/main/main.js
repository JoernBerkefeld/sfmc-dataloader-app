'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { CHANNELS } = require('../shared/channels');
const { JobManager } = require('./job-manager');
const { UpdaterService } = require('./updater');
const { SettingsStore } = require('./settings-store');
const { selectChangelog, readBundledChangelog } = require('./changelog');
const { Analytics } = require('./analytics');
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
 *   settings: SettingsStore | undefined,
 *   analytics: Analytics | undefined,
 * }}
 */
const state = {
    mainWindow: undefined,
    jobManager: undefined,
    updater: undefined,
    settings: undefined,
    analytics: undefined,
    interruptionPending: false,
    exitApproved: false,
};

/**
 * Serializes interruption decisions in the main process, never trusting renderer consent.
 *
 * @param {string} action
 * @param {() => void | boolean} proceed
 * @returns {Promise.<boolean>}
 */
async function requestInterruption(action, proceed) {
    if (state.interruptionPending || state.exitApproved) {
        return false;
    }
    state.interruptionPending = true;
    state.jobManager?.setStartsBlocked(true);
    try {
        if (state.jobManager?.hasActiveJobs()) {
            const options = {
                type: 'warning',
                buttons: ['Stay open', action],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
                message: `A job is still starting, running or stopping. ${action}?`,
                detail: 'This stops the local worker. Remote work already submitted to Salesforce may continue and cannot be undone by closing or cancelling here.',
            };
            const result = state.mainWindow
                ? await dialog.showMessageBox(state.mainWindow, options)
                : await dialog.showMessageBox(options);
            if (result.response !== 1) {
                return false;
            }
            if (!(await state.jobManager.cancelAll())) {
                return false;
            }
        }
        return proceed() !== false;
    } catch {
        // Failed dialogs or stop requests must never turn into permission to exit.
        return false;
    } finally {
        state.interruptionPending = false;
        if (!state.exitApproved) {
            state.jobManager?.setStartsBlocked(false);
        }
    }
}

/**
 * Exits only after the main-process interruption decision has completed.
 *
 * @returns {void}
 */
function approveQuit() {
    state.exitApproved = true;
    app.quit();
}

/**
 * Times the main-process config/discovery request only, excluding renderer prompts.
 * Presence checks read filenames, never config contents, and are consent-bound.
 *
 * @param {string} action
 * @param {unknown} projectRoot
 * @param {() => Promise.<object>} run
 * @returns {Promise.<object>}
 */
async function trackConfigAction(action, projectRoot, run) {
    const revision = state.analytics?.beginOperation();
    const started = performance.now();
    let result;
    try {
        result = await run();
        return result;
    } finally {
        if (state.analytics?.acceptsOperation(revision)) {
            const durationMs = performance.now() - started;
            const presence = await Promise.all(
                ['.mcdevrc.json', '.mcdatarc.json'].map(async (name) => {
                    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
                        return false;
                    }
                    try {
                        const stats = await fs.stat(path.join(projectRoot, name));
                        return stats.isFile();
                    } catch {
                        return false;
                    }
                }),
            );
            const isSuccess = result?.[action === 'config_load' ? 'configured' : 'ok'] === true;
            const buCount =
                action === 'de_discovery'
                    ? 1
                    : (result?.credentials ?? []).reduce(
                          (sum, credential) => sum + (credential.businessUnits?.length ?? 0),
                          0,
                      );
            state.analytics.trackActionOutcome(
                {
                    action,
                    result: isSuccess ? 'success' : 'error',
                    durationMs,
                    errorCategory:
                        action === 'config_load' ? 'config_unavailable' : 'discovery_failed',
                    buCount,
                    isMcdevProject: presence[0],
                    isMcdataProject: presence[1],
                },
                revision,
            );
        }
    }
}

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

    win.on('close', (event) => {
        if (
            state.exitApproved ||
            !(state.interruptionPending || state.jobManager?.hasActiveJobs())
        ) {
            return;
        }

        event.preventDefault();
        void requestInterruption('Stop job and close', approveQuit);
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
        trackConfigAction('config_load', projectRoot, () => configService.loadConfig(projectRoot)),
    );
    ipcMain.handle(CHANNELS.CONFIG_FETCH_DE_LIST, (_event, payload) =>
        trackConfigAction('de_discovery', payload?.projectRoot, () =>
            configService.fetchDeList(payload),
        ),
    );

    ipcMain.handle(CHANNELS.JOB_START, (_event, job) => {
        const revision = state.analytics?.beginOperation();
        try {
            return state.jobManager.start(job);
        } catch (ex) {
            if (state.analytics?.acceptsOperation(revision)) {
                state.analytics.trackJobOutcome({
                    kind: job?.kind,
                    result: 'error',
                    errorCategory: 'start_failed',
                    errorName: ex?.name,
                    errorCode: ex?.code,
                    durationMs: 0,
                });
            }
            throw ex;
        }
    });
    ipcMain.handle(CHANNELS.JOB_CANCEL, (_event, jobId) => {
        if (!state.jobManager.hasJob(jobId)) {
            return false;
        }
        return requestInterruption('Stop job', () => true);
    });

    ipcMain.handle(CHANNELS.CHANGELOG_GET, async () =>
        selectChangelog(
            await readBundledChangelog(),
            app.getVersion(),
            state.settings?.getChangelogAcknowledgement(),
        ),
    );
    ipcMain.handle(CHANNELS.CHANGELOG_ACKNOWLEDGE, () => state.settings?.acknowledgeChangelog());
    ipcMain.handle(CHANNELS.SETTINGS_GET, () => state.settings?.getState());
    ipcMain.handle(CHANNELS.SETTINGS_SET_TRANSFER_DEFAULTS, (_event, value) =>
        state.settings?.setTransferDefaults(value),
    );
    ipcMain.handle(CHANNELS.SETTINGS_SET_CONSENT, async (_event, value) => {
        state.analytics?.clearPending();
        const result = await state.settings?.setConsent(value);
        if (result?.firstConsentedRun) {
            state.analytics?.trackLifecycle('first-consented-run');
            state.analytics?.trackLoaderVersion();
        }
        return result;
    });
    ipcMain.handle(CHANNELS.SETTINGS_SET_PROJECT_ROOT, (_event, value) =>
        state.settings?.setProjectRoot(value),
    );

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

    // Load settings (clientId + consent) and derive the install/update/launch
    // lifecycle event. All I/O here is async so startup is never blocked.
    const settings = new SettingsStore({
        filePath: path.join(app.getPath('userData'), 'settings.json'),
        currentVersion: app.getVersion(),
    });
    const lifecycle = await settings.init();
    state.settings = settings;

    // Analytics is disabled in dev/unpackaged builds. Public EU ingestion
    // configuration is shared with the extension; all events still require consent.
    let loaderVersion;
    try {
        const entry = require.resolve('sfmc-dataloader');
        const metadataPath = path.join(path.dirname(entry), '..', 'package.json');
        loaderVersion = JSON.parse(await fs.readFile(metadataPath, 'utf8')).version;
    } catch {
        // Unknown is a safe metadata outcome; never send resolution errors or paths.
    }
    const analytics = new Analytics({
        settings,
        loaderVersion,
        appVersion: app.getVersion(),
        locale: app.getLocale(),
        enabled: app.isPackaged,
    });
    state.analytics = analytics;

    // Pending/declined consent drops startup events entirely, without buffering.
    // The first saved affirmative choice records a first-consented run, not an install.
    analytics.trackLifecycle(lifecycle.event);
    analytics.trackLoaderVersion();

    const getWebContents = () => (state.mainWindow ? state.mainWindow.webContents : undefined);
    state.jobManager = new JobManager(getWebContents, analytics);
    state.updater = new UpdaterService(getWebContents, {
        isPackaged: app.isPackaged,
        runInstall: (install) =>
            requestInterruption('Stop job and install update', () => {
                state.exitApproved = true;
                try {
                    install();
                } catch (ex) {
                    state.exitApproved = false;
                    throw ex;
                }
            }),
    });
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

app.on('before-quit', (event) => {
    if (state.exitApproved) {
        return;
    }
    event.preventDefault();
    void requestInterruption('Stop job and quit', approveQuit);
});

// Synchronous discard/abort bounds shutdown even if fetch never settles.
app.on('will-quit', () => state.analytics?.dispose());

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
