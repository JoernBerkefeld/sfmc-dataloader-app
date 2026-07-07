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

    // main -> renderer (send/on, one-way events)
    JOB_PROGRESS: 'job:progress',
    JOB_LOG: 'job:log',
    JOB_COMPLETE: 'job:complete',
    JOB_ERROR: 'job:error',
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
