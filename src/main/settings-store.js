'use strict';

// Persistent app settings, stored as a single small JSON file in the app's
// userData directory. This is the ONLY place a stable per-install identifier
// lives, and it deliberately holds nothing personal:
//
//   - clientId          a random UUID minted once per install. It identifies the
//                       *installation*, not the person, and is used only as the
//                       GA4 Measurement Protocol client_id so events can be de-
//                       duplicated / counted. It is never derived from anything
//                       about the machine or user.
//   - lastVersion       the app version last seen running. Comparing it to the
//                       current version distinguishes a fresh install from an
//                       update from a plain relaunch (for install/update/launch
//                       telemetry) without any server round-trip.
//   - telemetryConsent  true = opted in to optional usage telemetry, false =
//                       opted out, undefined = not asked yet (drives the first-
//                       run consent prompt). Mandatory lifecycle pings do not
//                       depend on this flag; only the optional usage events do.
//
// All disk I/O is async so nothing here blocks the main thread. The file path is
// injectable so tests can point at a temp file instead of the real userData dir.

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

/** Lifecycle event derived from comparing stored vs. current version. */
const LIFECYCLE = {
    INSTALL: 'install',
    UPDATE: 'update',
    LAUNCH: 'launch',
};

/**
 * Owns the on-disk settings file and derives the install/update/launch lifecycle
 * on startup. Construction does no I/O; call {@link SettingsStore#init} once the
 * app is ready.
 */
class SettingsStore {
    /**
     * @param {object} options
     * @param {string} options.filePath - absolute path to settings.json
     * @param {string} options.currentVersion - app.getVersion()
     */
    constructor(options) {
        /** @type {string} */
        this._filePath = options.filePath;
        /** @type {string} */
        this._currentVersion = options.currentVersion;
        /** @type {{ clientId: string, lastVersion: string | undefined, telemetryConsent: (boolean | undefined) }} */
        this._state = { clientId: '', lastVersion: undefined, telemetryConsent: undefined };
        /** @type {boolean} */
        this._loaded = false;
    }

    /**
     * Reads and parses the settings file, returning an empty object when it is
     * missing or unreadable (the normal first-run case).
     *
     * @returns {Promise.<Record<string, unknown>>}
     */
    async #read() {
        try {
            const raw = await fs.readFile(this._filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    /**
     * Persists the current state. Failures are swallowed: telemetry settings are
     * best-effort and must never surface an error to the user or crash startup.
     *
     * @returns {Promise.<void>}
     */
    async #write() {
        try {
            const contents = JSON.stringify(this._state, undefined, 4) + '\n';
            await fs.writeFile(this._filePath, contents, 'utf8');
        } catch {
            // best-effort; a read-only userData dir simply means settings do not
            // persist across launches — not a fatal condition.
        }
    }

    /**
     * Reads the settings file (tolerating a missing/corrupt file as a first run),
     * ensures a clientId exists, determines the lifecycle event by comparing the
     * stored version to the current one, then persists the refreshed state
     * (clientId + current version). Safe to call once at startup.
     *
     * @returns {Promise.<{ event: string, clientId: string, previousVersion: (string | undefined) }>}
     */
    async init() {
        const stored = await this.#read();

        const isHadClientId = typeof stored.clientId === 'string' && stored.clientId.length > 0;
        const clientId = isHadClientId ? stored.clientId : crypto.randomUUID();
        const previousVersion =
            typeof stored.lastVersion === 'string' ? stored.lastVersion : undefined;
        const telemetryConsent =
            stored.telemetryConsent === true || stored.telemetryConsent === false
                ? stored.telemetryConsent
                : undefined;

        let event = LIFECYCLE.LAUNCH;
        if (!isHadClientId && previousVersion === undefined) {
            event = LIFECYCLE.INSTALL;
        } else if (previousVersion !== this._currentVersion) {
            event = LIFECYCLE.UPDATE;
        }

        this._state = { clientId, lastVersion: this._currentVersion, telemetryConsent };
        this._loaded = true;
        await this.#write();

        return { event, clientId, previousVersion };
    }

    /**
     * @returns {string} the stable per-install client id (empty before init)
     */
    getClientId() {
        return this._state.clientId;
    }

    /**
     * @returns {boolean | undefined} true/false once chosen, undefined when not asked yet
     */
    getConsent() {
        return this._state.telemetryConsent;
    }

    /**
     * @returns {{ clientId: string, consent: (boolean | undefined), version: string }} a snapshot for the renderer
     */
    getState() {
        return {
            clientId: this._state.clientId,
            consent: this._state.telemetryConsent,
            version: this._currentVersion,
        };
    }

    /**
     * Records the user's optional-telemetry choice and persists it.
     *
     * @param {boolean} value - true to opt in, false to opt out
     * @returns {Promise.<{ clientId: string, consent: boolean, version: string }>}
     */
    async setConsent(value) {
        this._state.telemetryConsent = Boolean(value);
        await this.#write();
        return this.getState();
    }
}

module.exports = { SettingsStore, LIFECYCLE };
