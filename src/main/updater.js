'use strict';

const { CHANNELS } = require('../shared/channels');
const { UPDATE_STATUS } = require('../shared/update-status');

/**
 * Lazily resolves electron-updater's singleton. Accessing `autoUpdater`
 * instantiates a platform updater that reads `app.getVersion()`, so it must not
 * run at module load (that would crash under plain Node in tests). Production
 * calls this from the constructor when no updater is injected.
 *
 * @returns {import('electron-updater').AppUpdater}
 */
function defaultUpdater() {
    return require('electron-updater').autoUpdater;
}

// Thin wrapper around electron-updater. It wires the updater's event stream to
// our transport-agnostic UPDATE_STATUS vocabulary (see src/shared/update-status.js)
// and forwards each state to the renderer over the update:status channel.
//
// Downloads are automatic; installation is not. We call quitAndInstall() only
// when the user explicitly asks (a data-loader must never restart mid-job), so
// autoInstallOnAppQuit is left at its default and we never force a restart.

/**
 * Owns the auto-update lifecycle for the app. Construction only wires event
 * handlers; nothing hits the network until {@link UpdaterService#checkForUpdates}
 * runs, so unit tests can build one against a fake updater without side effects.
 */
class UpdaterService {
    /**
     * @param {() => import('electron').WebContents | null | undefined} getWebContents
     * @param {object} [options]
     * @param {import('electron-updater').AppUpdater} [options.updater] - injectable for tests
     * @param {boolean} [options.isPackaged] - defaults to true; when false, checks are skipped
     */
    constructor(getWebContents, options = {}) {
        /** @type {() => import('electron').WebContents | null | undefined} */
        this._getWebContents = getWebContents;
        /** @type {import('electron-updater').AppUpdater} */
        this._updater = options.updater ?? defaultUpdater();
        /** @type {boolean} */
        this._isPackaged = options.isPackaged ?? true;
        /** @type {import('../shared/update-status').UpdateState} */
        this._state = { status: UPDATE_STATUS.IDLE };

        // Downloads happen automatically; we control only the install/restart.
        this._updater.autoDownload = true;
        this._updater.autoInstallOnAppQuit = false;

        this.#wireEvents();
    }

    /**
     * Subscribes to electron-updater's lifecycle events and republishes each as
     * an UPDATE_STATUS state to the renderer.
     *
     * @returns {void}
     */
    #wireEvents() {
        this._updater.on('checking-for-update', () => {
            this.#setState({ status: UPDATE_STATUS.CHECKING });
        });
        this._updater.on('update-available', (info) => {
            this.#setState({ status: UPDATE_STATUS.AVAILABLE, version: info?.version });
        });
        this._updater.on('update-not-available', () => {
            this.#setState({ status: UPDATE_STATUS.NOT_AVAILABLE });
        });
        this._updater.on('download-progress', (progress) => {
            this.#setState({
                status: UPDATE_STATUS.DOWNLOADING,
                percent: progress?.percent,
                version: this._state.version,
            });
        });
        this._updater.on('update-downloaded', (info) => {
            this.#setState({ status: UPDATE_STATUS.DOWNLOADED, version: info?.version });
        });
        this._updater.on('error', (error) => {
            this.#setState({
                status: UPDATE_STATUS.ERROR,
                message: error == undefined ? 'unknown error' : String(error.message ?? error),
            });
        });
    }

    /**
     * Stores the latest state and pushes it to the renderer if a window exists.
     *
     * @param {import('../shared/update-status').UpdateState} state
     * @returns {void}
     */
    #setState(state) {
        this._state = state;
        const webContents = this._getWebContents();
        if (webContents && !webContents.isDestroyed()) {
            webContents.send(CHANNELS.UPDATE_STATUS, state);
        }
    }

    /**
     * @returns {import('../shared/update-status').UpdateState} the last known update state
     */
    getState() {
        return this._state;
    }

    /**
     * Triggers a background check (and, if configured, download). No-ops in a
     * development/unpackaged build where electron-updater cannot resolve a feed.
     *
     * @returns {Promise.<void>}
     */
    async checkForUpdates() {
        if (!this._isPackaged) {
            return;
        }
        // electron-updater only drives updates for self-updating bundles (NSIS,
        // dmg, AppImage). For store/package-manager formats (deb, rpm, snap) it
        // reports inactive — skip quietly so those users don't see a spurious
        // "update check failed" banner (their package manager handles updates).
        if (
            typeof this._updater.isUpdaterActive === 'function' &&
            !this._updater.isUpdaterActive()
        ) {
            return;
        }
        try {
            await this._updater.checkForUpdates();
        } catch (ex) {
            this.#setState({
                status: UPDATE_STATUS.ERROR,
                message: ex && ex.message ? ex.message : String(ex),
            });
        }
    }

    /**
     * Quits and installs a previously downloaded update. Safe to call only when
     * the current state is DOWNLOADED; otherwise it is a no-op.
     *
     * @returns {boolean} true when an install/restart was initiated
     */
    quitAndInstall() {
        if (this._state.status !== UPDATE_STATUS.DOWNLOADED) {
            return false;
        }
        this._updater.quitAndInstall();
        return true;
    }
}

module.exports = { UpdaterService };
