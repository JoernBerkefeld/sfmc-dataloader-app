'use strict';

// Pure, side-effect-free helpers describing the in-app auto-update lifecycle.
// Shared by the Electron main process (which drives electron-updater), the Node
// tests, AND the sandboxed renderer (which paints an update banner). Like
// file-size.js it exports normally under CommonJS and also attaches itself to
// `globalThis.McUpdate` when loaded as a plain <script> in the renderer.
//
// electron-updater only produces real updates in a packaged, published build.
// The state machine here is deliberately transport-agnostic: main translates
// electron-updater events into these statuses, and the renderer renders them,
// so neither side needs to know the other's vocabulary.

/** The stages an update can be in, mirrored from electron-updater's events. */
const UPDATE_STATUS = {
    IDLE: 'idle',
    CHECKING: 'checking',
    AVAILABLE: 'available',
    NOT_AVAILABLE: 'not-available',
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    ERROR: 'error',
};

/**
 * @typedef {object} UpdateState
 * @property {string} status - one of UPDATE_STATUS
 * @property {string} [version] - the target version (available/downloaded)
 * @property {number} [percent] - download progress in [0,100] while downloading
 * @property {string} [message] - error text when status is 'error'
 */

/**
 * Clamps a raw percent value into a whole number in [0,100]. Non-numeric input
 * yields 0 so the progress UI never renders NaN.
 *
 * @param {unknown} percent
 * @returns {number}
 */
function clampPercent(percent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        return 0;
    }
    return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Turns an update state into a short human-readable line plus flags the
 * renderer uses to decide which controls to show. `canInstall` is true only
 * once an update has been fully downloaded and is ready to apply on restart.
 *
 * @param {UpdateState} state
 * @returns {{ text: string, canInstall: boolean, isBusy: boolean }}
 */
function describeUpdateStatus(state) {
    const safe = state && typeof state === 'object' ? state : { status: UPDATE_STATUS.IDLE };
    switch (safe.status) {
        case UPDATE_STATUS.CHECKING: {
            return { text: 'Checking for updates…', canInstall: false, isBusy: true };
        }
        case UPDATE_STATUS.AVAILABLE: {
            const version = safe.version ? ` (v${safe.version})` : '';
            return {
                text: `Update available${version} — downloading…`,
                canInstall: false,
                isBusy: true,
            };
        }
        case UPDATE_STATUS.NOT_AVAILABLE: {
            return { text: 'You are on the latest version.', canInstall: false, isBusy: false };
        }
        case UPDATE_STATUS.DOWNLOADING: {
            return {
                text: `Downloading update… ${clampPercent(safe.percent)}%`,
                canInstall: false,
                isBusy: true,
            };
        }
        case UPDATE_STATUS.DOWNLOADED: {
            const version = safe.version ? ` (v${safe.version})` : '';
            return {
                text: `Update ready${version}. Restart to install.`,
                canInstall: true,
                isBusy: false,
            };
        }
        case UPDATE_STATUS.ERROR: {
            const detail = safe.message ? `: ${safe.message}` : '.';
            return { text: `Update check failed${detail}`, canInstall: false, isBusy: false };
        }
        default: {
            return { text: '', canInstall: false, isBusy: false };
        }
    }
}

const api = { UPDATE_STATUS, clampPercent, describeUpdateStatus };

/**
 * Attaches the API to a global-like object. Written as a helper taking the
 * target as a parameter (mirrors src/shared/file-size.js) so the sandboxed
 * renderer can expose `McUpdate` without a bundler.
 *
 * @param {Record<string, unknown>} target
 * @returns {void}
 */
function attachGlobal(target) {
    target.McUpdate = api;
}

if (typeof module === 'object' && module.exports) {
    // CommonJS: main process + Node tests require this module.
    module.exports = api;
} else if (typeof globalThis !== 'undefined') {
    // Sandboxed renderer loads this as a plain <script>; expose the helpers.
    attachGlobal(globalThis);
}
