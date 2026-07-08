'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// NOTE: a sandboxed preload (webPreferences.sandbox = true) can only `require`
// the `electron` module and Node built-ins — never a local file such as
// `../shared/channels`. The channel names are therefore inlined here. The
// canonical list lives in `src/shared/channels.js` (used by the main process
// and tests); `test/preload-channels.test.js` guards the two against drift.
const CHANNELS = {
    APP_INFO: 'app:info',
    DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
    DIALOG_OPEN_FILES: 'dialog:openFiles',
    OPEN_PATH: 'shell:openPath',

    CONFIG_LOAD: 'config:load',
    CONFIG_FETCH_DE_LIST: 'config:fetchDeList',

    JOB_START: 'job:start',
    JOB_CANCEL: 'job:cancel',

    SETTINGS_GET: 'settings:get',
    SETTINGS_SET_CONSENT: 'settings:setConsent',

    UPDATE_CHECK: 'update:check',
    UPDATE_INSTALL: 'update:install',

    JOB_PROGRESS: 'job:progress',
    JOB_LOG: 'job:log',
    JOB_COMPLETE: 'job:complete',
    JOB_ERROR: 'job:error',
    UPDATE_STATUS: 'update:status',
};

// Inlined for the same sandbox reason as CHANNELS above. Canonical source is
// `src/shared/channels.js`; `test/preload-channels.test.js` guards against drift.
const JOB_KIND = {
    INIT: 'init',
    EXPORT: 'export',
    EXPORT_MULTI_BU: 'exportMultiBu',
    IMPORT: 'import',
    IMPORT_CROSS_BU: 'importCrossBu',
};

/**
 * Minimal, allow-listed bridge exposed to the sandboxed renderer as
 * `window.mcdata`. The renderer never touches Node or ipcRenderer directly;
 * every call maps to a known channel. Job event listeners return an
 * unsubscribe function so the renderer can clean up per-screen.
 */
const api = {
    /** Job-kind constants, mirrored from src/shared/channels.js. */
    JOB_KIND,

    /** @returns {Promise.<object>} basic app/runtime info */
    getAppInfo: () => ipcRenderer.invoke(CHANNELS.APP_INFO),

    /** @returns {Promise.<string | null>} chosen directory path, or null if cancelled */
    chooseDirectory: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN_DIRECTORY),

    /**
     * @param {{ extensions?: string[] }} [options]
     * @returns {Promise.<{ path: string, size: number }[]>} chosen files with byte
     * sizes (empty if cancelled); size is 0 when the file could not be stat'd
     */
    chooseFiles: (options) => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN_FILES, options),

    /**
     * @param {string} targetPath
     * @returns {Promise.<string>} empty string on success, else an error message
     */
    openPath: (targetPath) => ipcRenderer.invoke(CHANNELS.OPEN_PATH, targetPath),

    // --- config / connections (added in the auth-config step) -----------------
    /**
     * Reads a sanitized view (credentials + business units, never secrets) of
     * the project's saved config.
     *
     * @param {string} projectRoot
     * @returns {Promise.<object>}
     */
    loadConfig: (projectRoot) => ipcRenderer.invoke(CHANNELS.CONFIG_LOAD, projectRoot),
    /**
     * Lists Data Extensions for a credential/BU via a live authenticated call;
     * doubles as a connection test.
     *
     * @param {{ projectRoot: string, credential: string, bu: string }} payload
     * @returns {Promise.<object>}
     */
    fetchDeList: (payload) => ipcRenderer.invoke(CHANNELS.CONFIG_FETCH_DE_LIST, payload),

    // --- jobs (added in the worker/ipc-progress step) ------------------------
    /**
     * @param {object} job
     * @returns {Promise.<{jobId: string}>}
     */
    startJob: (job) => ipcRenderer.invoke(CHANNELS.JOB_START, job),
    /** @param {string} jobId */
    cancelJob: (jobId) => ipcRenderer.invoke(CHANNELS.JOB_CANCEL, jobId),

    /**
     * @param {(payload: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onJobProgress: (handler) => subscribe(CHANNELS.JOB_PROGRESS, handler),
    /**
     * @param {(payload: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onJobLog: (handler) => subscribe(CHANNELS.JOB_LOG, handler),
    /**
     * @param {(payload: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onJobComplete: (handler) => subscribe(CHANNELS.JOB_COMPLETE, handler),
    /**
     * @param {(payload: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onJobError: (handler) => subscribe(CHANNELS.JOB_ERROR, handler),

    // --- telemetry consent ---------------------------------------------------
    /**
     * Reads the telemetry settings snapshot: `{ clientId, consent, version }`
     * where consent is true (opted in), false (opted out), or undefined (not
     * asked yet — drives the first-run consent prompt).
     *
     * @returns {Promise.<{ clientId: string, consent: (boolean | undefined), version: string }>}
     */
    getSettings: () => ipcRenderer.invoke(CHANNELS.SETTINGS_GET),
    /**
     * Records the user's optional-telemetry choice.
     *
     * @param {boolean} value - true to opt in, false to opt out
     * @returns {Promise.<{ clientId: string, consent: boolean, version: string }>}
     */
    setTelemetryConsent: (value) => ipcRenderer.invoke(CHANNELS.SETTINGS_SET_CONSENT, value),

    // --- auto-update (electron-updater) --------------------------------------
    /**
     * Asks the main process to check for updates now. Downloads happen
     * automatically; progress arrives via {@link onUpdateStatus}.
     *
     * @returns {Promise.<void>}
     */
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.UPDATE_CHECK),
    /**
     * Requests quit-and-install of an already-downloaded update.
     *
     * @returns {Promise.<boolean>} true if an install/restart was initiated
     */
    installUpdate: () => ipcRenderer.invoke(CHANNELS.UPDATE_INSTALL),
    /**
     * @param {(state: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onUpdateStatus: (handler) => subscribe(CHANNELS.UPDATE_STATUS, handler),
};

/**
 * @param {string} channel
 * @param {(payload: object) => void} handler
 * @returns {() => void} unsubscribe function
 */
function subscribe(channel, handler) {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {object} payload
     */
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mcdata', api);
