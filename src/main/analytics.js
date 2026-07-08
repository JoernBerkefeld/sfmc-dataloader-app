'use strict';

// GA4 Measurement Protocol sender for the main process.
//
// Non-blocking guarantee (a hard requirement): NOTHING in the track* path ever
// blocks the main thread. Each track call returns synchronously after scheduling
// the work with setImmediate; the actual payload build + network POST run on a
// later tick and are fire-and-forget (never awaited). A per-request
// AbortSignal.timeout guarantees a hung/slow endpoint can never accumulate open
// sockets. Any error — offline, DNS failure, non-2xx — is swallowed: telemetry
// must never affect the app.
//
// Gating, in order (a send is dropped as soon as one fails):
//   1. enabled            false in dev/unpackaged builds (no telemetry locally)
//   2. isConfigured()     false when the GA4 ids were not injected at build time
//   3. consent (opt-in)   optional usage events require telemetryConsent === true;
//                         mandatory lifecycle pings ignore this gate
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
     * @param {boolean} [options.enabled] - false disables all sends (dev builds)
     * @param {object} [options.config] - analytics-config override (endpoint + ids), for tests
     * @param {typeof fetch} [options.fetch] - injectable fetch, for tests
     * @param {(callback: () => void) => void} [options.schedule] - deferral fn, defaults to setImmediate
     * @param {object} [options.runtime] - { platform, arch, env, windowsStore } for channel detection
     * @param {string} [options.osVersion] - override os.release(), for tests
     */
    constructor(options) {
        /** @type {import('./settings-store').SettingsStore} */
        this._settings = options.settings;
        /** @type {string} */
        this._appVersion = options.appVersion;
        /** @type {string | undefined} */
        this._locale = options.locale;
        /** @type {boolean} */
        this._enabled = options.enabled ?? true;
        /** @type {object} */
        this._config = options.config ?? defaultConfig;
        /** @type {typeof fetch} */
        this._fetch = options.fetch ?? globalThis.fetch;
        /** @type {(callback: () => void) => void} */
        this._schedule = options.schedule ?? setImmediate;
        /** @type {{ platform: string, arch: string, env: Record<string, string | undefined>, windowsStore?: boolean }} */
        this._runtime = options.runtime ?? {
            platform: process.platform,
            arch: process.arch,
            env: process.env,
            windowsStore: process.windowsStore,
        };
        /** @type {string} */
        this._osVersion = options.osVersion ?? os.release();
        /** @type {string} */
        this._channel = events.installChannel(this._runtime);
        // Per-process session id keeps GA4's active-user / engagement reporting
        // working. It is random and rotates every launch, so it identifies a run,
        // not a person, and adds no information beyond the existing client_id.
        /** @type {string} */
        this._sessionId = String(Date.now());
    }

    /**
     * Gates, defers, and dispatches a single event. Returns immediately; the
     * fetch is scheduled for a later tick and never awaited.
     *
     * @param {string} name - GA4 event name
     * @param {Record<string, string | number | boolean>} parameters - already sanitised
     * @param {boolean} requireConsent - true for optional usage events
     * @returns {void}
     */
    #send(name, parameters, requireConsent) {
        if (!this.isActive()) {
            return;
        }
        if (requireConsent && this._settings.getConsent() !== true) {
            return;
        }
        const clientId = this._settings.getClientId();
        if (!clientId) {
            return;
        }

        // Defer everything off the caller's tick so building the payload and the
        // network call can never add latency to the action that triggered it.
        this._schedule(() => {
            this.#post(clientId, name, parameters);
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
        const url =
            `${this._config.MP_ENDPOINT}?measurement_id=${encodeURIComponent(this._config.MEASUREMENT_ID)}` +
            `&api_secret=${encodeURIComponent(this._config.API_SECRET)}`;

        const body = JSON.stringify({
            client_id: clientId,
            non_personalized_ads: true,
            events: [
                {
                    name,
                    params: {
                        ...parameters,
                        session_id: this._sessionId,
                        engagement_time_msec: 1,
                    },
                },
            ],
        });

        try {
            // Awaited inside try/catch so any rejection (offline, timeout, DNS,
            // non-2xx) or synchronous throw (fetch unavailable) is swallowed —
            // telemetry is strictly best-effort and must never affect the app.
            await this._fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch {
            // ignore — best-effort only
        }
    }

    /**
     * True only when a network send could actually happen (enabled + ids present).
     * Consent is checked per-event, not here.
     *
     * @returns {boolean}
     */
    isActive() {
        return this._enabled === true && this._config.isConfigured();
    }

    // --- mandatory lifecycle events (no consent gate, no locale) --------------

    /**
     * Fires the lifecycle ping matching the startup event derived by the settings
     * store: 'install' -> app_install, 'update' -> app_update, anything else ->
     * app_launch. app_launch always fires so active-install counts stay accurate.
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
        if (event === 'install') {
            this.#send(events.EVENTS.APP_INSTALL, parameters, false);
        } else if (event === 'update') {
            this.#send(events.EVENTS.APP_UPDATE, parameters, false);
        }
        // app_launch is sent on EVERY startup (install and update included) so it
        // is a reliable daily-active / active-install signal.
        this.#send(events.EVENTS.APP_LAUNCH, parameters, false);
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
        this.#send(events.EVENTS.EXPORT_USED, parameters, true);
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
        this.#send(events.EVENTS.IMPORT_USED, parameters, true);
    }

    /**
     * @param {{ kind: unknown, result: unknown, rowCount?: number }} info
     * @returns {void}
     */
    trackJobOutcome(info) {
        const parameters = events.buildJobOutcomeParams({
            appVersion: this._appVersion,
            kind: info.kind,
            result: info.result,
            rowCount: info.rowCount,
            locale: this._locale,
        });
        this.#send(events.EVENTS.JOB_OUTCOME, parameters, true);
    }
}

module.exports = { Analytics };
