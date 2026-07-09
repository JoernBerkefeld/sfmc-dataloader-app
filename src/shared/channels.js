'use strict';

/**
 * IPC channel names shared between the main process, preload bridge and renderer.
 * Kept in a plain CommonJS module so both the Electron main process (CJS) and the
 * preload script (CJS) can require it without a build step.
 */
const CHANNELS = {
    // renderer -> main (invoke/handle, returns a promise)
    APP_INFO: 'app:info',
    DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
    DIALOG_OPEN_FILES: 'dialog:openFiles',
    OPEN_PATH: 'shell:openPath',

    // A connection is *saved* by running an INIT job in the worker (so the
    // client secret never touches the OS process table); there is therefore no
    // config:save channel. Fetching the DE list authenticates live, so it also
    // doubles as the "test connection" action — no separate channel for that.
    CONFIG_LOAD: 'config:load',
    CONFIG_FETCH_DE_LIST: 'config:fetchDeList',

    JOB_START: 'job:start',
    JOB_CANCEL: 'job:cancel',

    // Telemetry consent (invoke/handle). GET returns the current settings
    // snapshot (clientId, consent tri-state, version); SET_CONSENT records the
    // user's opt-in/opt-out for optional usage telemetry.
    SETTINGS_GET: 'settings:get',
    SETTINGS_SET_CONSENT: 'settings:setConsent',
    // Persists the last selected project folder so it is restored on next launch.
    SETTINGS_SET_PROJECT_ROOT: 'settings:setProjectRoot',

    // Auto-update (electron-updater). CHECK/INSTALL are invoke/handle; the
    // updater pushes lifecycle changes back over the UPDATE_STATUS event.
    UPDATE_CHECK: 'update:check',
    UPDATE_INSTALL: 'update:install',

    // main -> renderer (send/on, one-way events)
    JOB_PROGRESS: 'job:progress',
    JOB_LOG: 'job:log',
    JOB_COMPLETE: 'job:complete',
    JOB_ERROR: 'job:error',
    UPDATE_STATUS: 'update:status',
};

/**
 * Job kinds the worker can execute. Mirrors the sfmc-dataloader CLI subcommands
 * plus the multi-/cross-BU variants exposed by the VS Code extension.
 */
const JOB_KIND = {
    INIT: 'init',
    EXPORT: 'export',
    EXPORT_MULTI_BU: 'exportMultiBu',
    IMPORT: 'import',
    IMPORT_CROSS_BU: 'importCrossBu',
};

module.exports = { CHANNELS, JOB_KIND };
