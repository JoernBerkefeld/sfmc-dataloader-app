'use strict';

// PostHog EU batch sender for the main process.
//
// Non-blocking guarantee (a hard requirement): NOTHING in the track* path ever
// blocks the main thread. Each track call returns synchronously after scheduling
// the work with setImmediate; the actual payload build + network POST run on a
// later tick and are fire-and-forget (never awaited). A per-request
// abort timeout guarantees a hung/slow endpoint can never accumulate open
// sockets. Any error — offline, DNS failure, non-2xx — is swallowed: telemetry
// must never affect the app.
//
// Gating, in order (a send is dropped as soon as one fails):
//   1. enabled            false in dev/unpackaged builds (no telemetry locally)
//   2. isConfigured()     validates the public PostHog EU ingestion configuration
//   3. consent (opt-in)   ALL events require saved, versioned affirmative consent;
//                         rechecked on dispatch, with no preconsent buffering
//
// See src/shared/telemetry-events.js for the PII firewall that shapes every
// event's params before they reach this sender.

const os = require('node:os');
const events = require('../shared/telemetry-events');
const defaultConfig = require('./analytics-config');

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Owns the analytics transport. Construction is side-effect-free; the first
 * network activity happens only when a track* method fires (and even then, on a
 * deferred tick).
 */
class Analytics {
    /**
     * @param {object} options
     * @param {import('./settings-store').SettingsStore} options.settings - source of clientId + consent
     * @param {string} options.appVersion - app.getVersion()
     * @param {string} [options.locale] - app.getLocale(), used only on opt-in events
     * @param {string} [options.loaderVersion] - resolved installed loader package version
     * @param {boolean} [options.enabled] - false disables all sends (dev builds)
     * @param {object} [options.config] - analytics-config override (endpoint + ids), for tests
     * @param {typeof fetch} [options.fetch] - injectable fetch, for tests
     * @param {(callback: () => void) => void} [options.schedule] - deferral fn, defaults to setImmediate
     * @param {object} [options.runtime] - { platform, arch, env, windowsStore } for channel detection
     * @param {string} [options.osVersion] - override os.release(), for tests
     */
    constructor(options) {
        /**
         * @type {import('./settings-store').SettingsStore}
         */
        this._settings = options.settings;
        /**
         * @type {string}
         */
        this._appVersion = options.appVersion;
        /**
         * @type {string | undefined}
         */
        this._locale = options.locale;
        this._loaderVersion = events.normalizeVersion(options.loaderVersion);
        /**
         * @type {boolean}
         */
        this._enabled = options.enabled ?? true;
        /**
         * @type {object}
         */
        this._config = options.config ?? defaultConfig;
        /**
         * @type {typeof fetch}
         */
        this._fetch = options.fetch ?? globalThis.fetch;
        /**
         * @type {(callback: () => void) => void}
         */
        this._schedule = options.schedule ?? setImmediate;
        /**
         * @type {{ platform: string, arch: string, env: Record<string, string | undefined>, windowsStore?: boolean }}
         */
        this._runtime = options.runtime ?? {
            platform: process.platform,
            arch: process.arch,
            env: process.env,
            windowsStore: process.windowsStore,
        };
        /**
         * @type {string}
         */
        this._osVersion = options.osVersion ?? os.release();
        /**
         * @type {string}
         */
        this._channel = events.installChannel(this._runtime);
        this._pending = new Map();
        this._inFlight = new Set();
        this._disposed = false;
    }

    /**
     * Gates, defers, and dispatches a single event. Returns immediately; the
     * fetch is scheduled for a later tick and never awaited.
     *
     * @param {string} name - catalogued app event name
     * @param {Record<string, string | number | boolean>} parameters - already sanitised
     * @returns {void}
     */
    #send(name, parameters) {
        if (!this.isActive() || this._settings.getConsent() !== true) {
            return;
        }
        const clientId = this._settings.getClientId();
        if (!clientId) {
            return;
        }

        // Defer everything off the caller's tick so building the payload and the
        // network call can never add latency to the action that triggered it.
        const revision = this._settings.getConsentRevision();
        const token = {};
        this._pending.set(token, { clientId, name, parameters });
        this._schedule(() => {
            const pending = this._pending.get(token);
            this._pending.delete(token);
            if (
                pending &&
                this.isActive() &&
                this._settings.getConsent() === true &&
                this._settings.getConsentRevision() === revision
            ) {
                this.#post(pending.clientId, pending.name, pending.parameters);
            }
        });
    }

    /**
     * Performs the fire-and-forget POST. Errors are swallowed by design.
     *
     * @param {string} clientId
     * @param {string} name
     * @param {Record<string, string | number | boolean>} parameters
     * @returns {Promise.<void>}
     */
    async #post(clientId, name, parameters) {
        const controller = new AbortController();
        this._inFlight.add(controller);
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        timeout.unref?.();

        try {
            const body = JSON.stringify({
                api_key: this._config.PROJECT_API_KEY,
                batch: [
                    {
                        event: name,
                        properties: {
                            ...parameters,
                            distinct_id: clientId,
                            app: 'sfmc-dataloader-app',
                            $process_person_profile: false,
                        },
                        timestamp: new Date().toISOString(),
                    },
                ],
            });
            // Awaited inside try/catch so any rejection (offline, timeout, DNS,
            // non-2xx) or synchronous throw (fetch unavailable) is swallowed —
            // telemetry is strictly best-effort and must never affect the app.
            await this._fetch(this._config.BATCH_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: controller.signal,
            });
        } catch {
            // ignore — best-effort only
        } finally {
            clearTimeout(timeout);
            this._inFlight.delete(controller);
        }
    }

    /**
     * Discards queued payloads immediately when consent changes.
     *
     * @returns {void}
     */
    clearPending() {
        this._pending.clear();
        for (const controller of this._inFlight) {
            controller.abort();
        }
        this._inFlight.clear();
    }

    /**
     * Stops immediately at shutdown, without waiting for a transport that may ignore abort.
     * Queued events are deliberately discarded rather than drained at exit.
     *
     * @returns {void}
     */
    dispose() {
        this._disposed = true;
        this.clearPending();
    }

    /**
     * True only when a network send could actually happen (enabled + ids present).
     * Consent is checked per-event, not here.
     *
     * @returns {boolean}
     */
    isActive() {
        return !this._disposed && this._enabled === true && this._config.isConfigured();
    }

    // --- lifecycle events (saved consent required, no locale) ----------------

    /**
     * Records a consenting startup or the first saved affirmative choice.
     * Never translates an install/migration into an installation count. Events
     * dropped before consent are not replayed when a choice is later saved.
     *
     * @param {string} event - one of settings-store LIFECYCLE values
     * @returns {void}
     */
    trackLifecycle(event) {
        const parameters = events.buildLifecycleParams({
            appVersion: this._appVersion,
            platform: this._runtime.platform,
            osVersion: this._osVersion,
            arch: this._runtime.arch,
            channel: this._channel,
        });
        if (event === 'first-consented-run') {
            this.#send(events.EVENTS.FIRST_CONSENTED_RUN, parameters);
        } else if (event === 'update') {
            this.#send(events.EVENTS.APP_UPDATE, parameters);
        }
        // Launches describe consenting runs only, never all active installations.
        this.#send(events.EVENTS.APP_LAUNCH, parameters);
    }

    /**
     * Captures eligibility without retaining activity before a saved opt-in.
     *
     * @returns {number | undefined}
     */
    beginOperation() {
        return this.isActive() && this._settings.getConsent() === true
            ? this._settings.getConsentRevision()
            : undefined;
    }

    /**
     * Rejects work spanning a consent change, including opt-out then opt-in.
     *
     * @param {number | undefined} revision
     * @returns {boolean}
     */
    acceptsOperation(revision) {
        return revision !== undefined && revision === this.beginOperation();
    }

    /**
     * Reports the installed runtime package, not a dependency range or CLI source.
     *
     * @returns {void}
     */
    trackLoaderVersion() {
        this.#send(events.EVENTS.LOADER_VERSION, {
            app_version: this._appVersion,
            loader_version: this._loaderVersion,
        });
    }

    /**
     * @param {object} info
     * @param {number | undefined} revision
     * @returns {void}
     */
    trackActionOutcome(info, revision) {
        if (this.acceptsOperation(revision)) {
            this.#send(
                events.EVENTS.ACTION_OUTCOME,
                events.buildActionOutcomeParams({
                    ...info,
                    appVersion: this._appVersion,
                    locale: this._locale,
                }),
            );
        }
    }

    // --- optional usage events (consent required, locale attached) ------------

    /**
     * @param {{ format: unknown, deCount: number, multiBu?: boolean }} info
     * @returns {void}
     */
    trackExport(info) {
        const parameters = events.buildExportParams({
            appVersion: this._appVersion,
            format: info.format,
            deCount: info.deCount,
            multiBu: info.multiBu,
            locale: this._locale,
        });
        this.#send(events.EVENTS.EXPORT_USED, parameters);
    }

    /**
     * @param {{ format: unknown, deCount: number, fileCount?: number, totalBytes?: number, mode?: string, crossBu?: boolean }} info
     * @returns {void}
     */
    trackImport(info) {
        const parameters = events.buildImportParams({
            appVersion: this._appVersion,
            format: info.format,
            deCount: info.deCount,
            fileCount: info.fileCount,
            totalBytes: info.totalBytes,
            mode: info.mode,
            crossBu: info.crossBu,
            locale: this._locale,
        });
        this.#send(events.EVENTS.IMPORT_USED, parameters);
    }

    /**
     * @param {{ kind: unknown, result: unknown, rowCount?: number, durationMs?: number, errorCategory?: string, errorName?: unknown, errorCode?: unknown }} info
     * @returns {void}
     */
    trackJobOutcome(info) {
        const parameters = events.buildJobOutcomeParams({
            appVersion: this._appVersion,
            kind: info.kind,
            result: info.result,
            rowCount: info.rowCount,
            durationMs: info.durationMs,
            errorCategory: info.errorCategory,
            errorName: info.errorName,
            errorCode: info.errorCode,
            locale: this._locale,
        });
        this.#send(events.EVENTS.JOB_OUTCOME, parameters);
    }
}

module.exports = { Analytics };
