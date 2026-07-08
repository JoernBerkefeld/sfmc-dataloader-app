#!/usr/bin/env node
/**
 * Injects the GA4 Measurement Protocol credentials into the app at build time.
 *
 * It reads `GA4_MEASUREMENT_ID` and `GA4_API_SECRET` from the environment (set
 * as GitHub Actions secrets in .github/workflows/build-release.yml) and writes
 * them to `src/main/analytics-config.generated.json`, which is gitignored and
 * bundled into the asar by electron-builder. `src/main/analytics-config.js`
 * loads that file at runtime; when it is absent analytics disables itself.
 *
 * This script is intentionally forgiving: if the secrets are not present (local
 * `npm run dist`, a fork, or a CI run without the secrets configured) it logs a
 * notice and exits 0 WITHOUT writing the file, so builds still succeed — they
 * simply ship with telemetry disabled.
 *
 * Usage:
 *   GA4_MEASUREMENT_ID=G-XXXX GA4_API_SECRET=yyyy node scripts/write-analytics-config.mjs
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'src', 'main', 'analytics-config.generated.json');

/**
 * Reads and trims an environment variable, returning an empty string when unset.
 *
 * @param {string} name
 * @returns {string}
 */
function readEnvironment(name) {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim() : '';
}

try {
    const measurementId = readEnvironment('GA4_MEASUREMENT_ID');
    const apiSecret = readEnvironment('GA4_API_SECRET');

    if (measurementId && apiSecret) {
        const contents = JSON.stringify({ measurementId, apiSecret }, undefined, 4) + '\n';
        await writeFile(OUTPUT, contents, 'utf8');
        console.log(
            `[write-analytics-config] wrote ${path.relative(ROOT, OUTPUT)} (${measurementId}).`,
        );
    } else {
        console.log(
            '[write-analytics-config] GA4_MEASUREMENT_ID / GA4_API_SECRET not set — ' +
                'skipping. This build will ship with telemetry disabled.',
        );
    }
} catch (ex) {
    console.error('[write-analytics-config] failed:', ex);
    process.exitCode = 1;
}
