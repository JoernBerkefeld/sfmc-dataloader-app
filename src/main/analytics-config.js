'use strict';

// GA4 Measurement Protocol configuration for the main process.
//
// The measurement id + api secret are NOT committed. They are injected at build
// time by scripts/write-analytics-config.mjs (reading the GA4_MEASUREMENT_ID /
// GA4_API_SECRET GitHub Actions secrets) into the gitignored
// `analytics-config.generated.json`, which electron-builder then bundles into
// the asar alongside this file. When that file is absent — local dev, forks, or
// any CI run without the secrets — the ids stay empty and analytics disables
// itself (see isConfigured()). No network call is ever made without both ids.

const fs = require('node:fs');
const path = require('node:path');

// EU data residency. `region1` is Google Analytics' EU ingestion endpoint for
// the Measurement Protocol, keeping collected events in the EU region.
const MP_ENDPOINT = 'https://region1.google-analytics.com/mp/collect';

const GENERATED_FILE = path.join(__dirname, 'analytics-config.generated.json');

/**
 * Reads the build-injected credentials once. A missing file (the common case in
 * development) or any parse error falls back to empty strings so analytics stays
 * disabled rather than throwing.
 *
 * @returns {{ measurementId: string, apiSecret: string }}
 */
function readGenerated() {
    try {
        const raw = fs.readFileSync(GENERATED_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            measurementId: typeof parsed.measurementId === 'string' ? parsed.measurementId : '',
            apiSecret: typeof parsed.apiSecret === 'string' ? parsed.apiSecret : '',
        };
    } catch {
        return { measurementId: '', apiSecret: '' };
    }
}

const injected = readGenerated();

const MEASUREMENT_ID = injected.measurementId;
const API_SECRET = injected.apiSecret;

/**
 * True only when both the measurement id and api secret were injected at build
 * time. The analytics service treats a false result as "telemetry off" and never
 * attempts a network request.
 *
 * @returns {boolean}
 */
function isConfigured() {
    return MEASUREMENT_ID.length > 0 && API_SECRET.length > 0;
}

module.exports = { MP_ENDPOINT, MEASUREMENT_ID, API_SECRET, isConfigured };
