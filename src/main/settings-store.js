'use strict';

// Persistent app settings, stored as a single small JSON file in the app's
// userData directory. This is the ONLY place a stable per-install identifier
// lives, and it deliberately holds nothing personal:
//
//   - clientId          a random UUID minted once per install. It identifies the
//                       *installation*, not the person, and is used only as the
//                       PostHog distinct_id so events can be de-
//                       duplicated / counted. It is never derived from anything
//                       about the machine or user.
//   - lastVersion       the app version last seen running. Comparing it to the
//                       current version distinguishes a fresh install from an
//                       update from a plain relaunch (for install/update/launch
//                       telemetry) without any server round-trip.
//   - telemetryConsent  explicit opt-in/out for ALL events. Legacy opt-ins are
//                       pending until renewed under telemetryConsentVersion.
//   - telemetryFirstConsentedRun marks a saved affirmative choice, not an install.
//                       It never implies exactly-once network delivery.
//   - projectRoot       the absolute path of the sfmc-dataloader project folder
//                       last selected by the user, so it is pre-filled on the
//                       next launch instead of forcing a re-pick every time. It
//                       is a plain filesystem path and is never sent anywhere.
//
// All disk I/O is async so nothing here blocks the main thread. The file path is
// injectable so tests can point at a temp file instead of the real userData dir.

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const CONSENT_VERSION = 1;

const TRANSFER_DEFAULTS = Object.freeze({
    format: 'csv',
    git: false,
    mode: 'upsert',
    backupBeforeImport: true,
    skipEmptyLines: false,
    debug: false,
});

/**
 * Accepts only safe transfer defaults; credentials and destructive choices never enter settings.
 *
 * @param {unknown} value
 * @returns {object}
 */
function normalizeTransferDefaults(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
        format: ['csv', 'tsv', 'json'].includes(input.format) ? input.format : 'csv',
        git: typeof input.git === 'boolean' ? input.git : false,
        mode: ['upsert', 'insert'].includes(input.mode) ? input.mode : 'upsert',
        backupBeforeImport:
            typeof input.backupBeforeImport === 'boolean' ? input.backupBeforeImport : true,
        skipEmptyLines: typeof input.skipEmptyLines === 'boolean' ? input.skipEmptyLines : false,
        debug: typeof input.debug === 'boolean' ? input.debug : false,
    };
}

/**
 * Lifecycle event derived from comparing stored vs. current version.
 */
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
     * @param {Function} [options.writeFile] - injectable settings writer for failure tests
     */
    constructor(options) {
        /**
         * @type {string}
         */
        this._filePath = options.filePath;
        this._writeFile = options.writeFile ?? fs.writeFile;
        /**
         * @type {string}
         */
        this._currentVersion = options.currentVersion;
        /**
         * @type {{ clientId: string, lastVersion: string | undefined, telemetryConsent: (boolean | undefined), telemetryConsentVersion?: number, telemetryFirstConsentedRun?: boolean, projectRoot: string, transferDefaults: object }}
         */
        this._state = {
            clientId: '',
            lastVersion: undefined,
            telemetryConsent: undefined,
            projectRoot: '',
            transferDefaults: { ...TRANSFER_DEFAULTS },
        };
        /**
         * @type {boolean}
         */
        this._loaded = false;
        this._consent = undefined;
        this._consentRevision = 0;
        this._persistence = { saved: false, error: undefined };
        this._writeQueue = Promise.resolve();
        this._writeRevision = 0;
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
     * Serializes writes so an older save cannot overwrite a newer choice.
     * Failures retain session settings but are explicitly reported to callers.
     *
     * @param {object} [overrides] - a candidate affirmative choice, not yet active in memory
     * @returns {Promise.<{ saved: boolean, error: (string | undefined) }>}
     */
    #write(overrides = {}) {
        const revision = ++this._writeRevision;
        const contents = JSON.stringify({ ...this._state, ...overrides }, undefined, 4) + '\n';
        this._persistence = { saved: false, error: undefined };
        const previous = this._writeQueue;
        this._writeQueue = (async () => {
            await previous;
            try {
                await this._writeFile(this._filePath, contents, 'utf8');
                this._persistence = {
                    saved: revision === this._writeRevision,
                    error: undefined,
                };
            } catch {
                this._persistence = { saved: false, error: 'Could not write app settings.' };
            }
            return { ...this._persistence };
        })();
        return this._writeQueue;
    }

    /**
     * Reads the settings file (tolerating a missing/corrupt file as a first run),
     * ensures a clientId exists, determines the lifecycle event by comparing the
     * stored version to the current one, then persists the refreshed state
     * (clientId + current version). Safe to call once at startup.
     *
     * @returns {Promise.<{ event: string, clientId: string, previousVersion: (string | undefined), persistence: { saved: boolean, error: (string | undefined) } }>}
     */
    async init() {
        const stored = await this.#read();

        const isHadClientId = typeof stored.clientId === 'string' && stored.clientId.length > 0;
        const clientId = isHadClientId ? stored.clientId : crypto.randomUUID();
        const previousVersion =
            typeof stored.lastVersion === 'string' ? stored.lastVersion : undefined;
        const telemetryConsent =
            stored.telemetryConsent === false ||
            (stored.telemetryConsent === true && stored.telemetryConsentVersion === CONSENT_VERSION)
                ? stored.telemetryConsent
                : undefined;
        const projectRoot = typeof stored.projectRoot === 'string' ? stored.projectRoot : '';

        let event = LIFECYCLE.LAUNCH;
        if (!isHadClientId && previousVersion === undefined) {
            event = LIFECYCLE.INSTALL;
        } else if (previousVersion !== this._currentVersion) {
            event = LIFECYCLE.UPDATE;
        }

        this._state = {
            clientId,
            lastVersion: this._currentVersion,
            telemetryConsent,
            telemetryConsentVersion: CONSENT_VERSION,
            telemetryFirstConsentedRun:
                stored.telemetryConsentVersion === CONSENT_VERSION &&
                stored.telemetryFirstConsentedRun === true,
            projectRoot,
            transferDefaults: normalizeTransferDefaults(stored.transferDefaults),
        };
        this._loaded = true;
        // Only previously saved, versioned affirmative consent can enable startup telemetry.
        this._consent = telemetryConsent;
        await this.#write();

        return { event, clientId, previousVersion, persistence: { ...this._persistence } };
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
        return this._consent;
    }

    /**
     * Changes on every choice, invalidating telemetry queued before a withdrawal.
     *
     * @returns {number}
     */
    getConsentRevision() {
        return this._consentRevision;
    }

    /**
     * @returns {string} the last selected project folder (empty when never set)
     */
    getProjectRoot() {
        return this._state.projectRoot;
    }

    /**
     * @returns {{ clientId: string, consent: (boolean | undefined), version: string, projectRoot: string, transferDefaults: object, persistence: { saved: boolean, error: (string | undefined) } }} a snapshot for the renderer
     */
    getState() {
        return {
            clientId: this._state.clientId,
            consent: this._consent,
            version: this._currentVersion,
            projectRoot: this._state.projectRoot,
            transferDefaults: { ...this._state.transferDefaults },
            persistence: { ...this._persistence },
        };
    }

    /**
     * Persists the user's all-event choice, activating opt-in only after saving.
     *
     * @param {boolean} value - true to opt in, false to opt out
     * @returns {Promise.<{ clientId: string, consent: (boolean | undefined), version: string, projectRoot: string, transferDefaults: object, firstConsentedRun: boolean, persistence: { saved: boolean, error: (string | undefined) } }>}
     */
    async setConsent(value) {
        const revision = ++this._consentRevision;
        const isAccepted = value === true;
        const isFirst = isAccepted && !this._state.telemetryFirstConsentedRun;
        // Withdrawal takes effect immediately; affirmative consent waits for disk.
        this._consent = isAccepted ? undefined : false;
        this._state.telemetryConsent = isAccepted ? undefined : false;
        this._state.telemetryConsentVersion = CONSENT_VERSION;
        const candidate = {
            telemetryConsent: isAccepted,
            telemetryFirstConsentedRun: isFirst || this._state.telemetryFirstConsentedRun,
        };
        const persistence = await this.#write(candidate);
        if (revision === this._consentRevision) {
            if (isAccepted && persistence.saved) {
                Object.assign(this._state, candidate);
                this._consent = true;
            } else if (isAccepted) {
                if (isFirst) {
                    this._state.telemetryFirstConsentedRun = false;
                }
                // Do not let an unrelated later settings save activate this failed choice.
                this._state.telemetryConsent = undefined;
            }
        }
        return {
            ...this.getState(),
            firstConsentedRun: isFirst && persistence.saved && this._consent === true,
        };
    }

    /**
     * Records the last selected project folder and persists it so the next
     * launch can pre-fill it. A non-string clears the stored value.
     *
     * @param {string} value - absolute path to the project folder
     * @returns {Promise.<{ clientId: string, consent: (boolean | undefined), version: string, projectRoot: string, transferDefaults: object, persistence: { saved: boolean, error: (string | undefined) } }>}
     */
    async setProjectRoot(value) {
        this._state.projectRoot = typeof value === 'string' ? value : '';
        await this.#write();
        return this.getState();
    }
    /**
     * Replaces safe defaults, preserving the session choice if saving fails.
     *
     * @param {object} value
     * @returns {Promise.<object>} settings snapshot with persistence outcome
     */
    async setTransferDefaults(value) {
        this._state.transferDefaults = normalizeTransferDefaults(value);
        await this.#write();
        return this.getState();
    }
}

module.exports = { SettingsStore, LIFECYCLE };
