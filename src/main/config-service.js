'use strict';

// Main-process-side config helpers. Thin wrappers around sfmc-dataloader's
// config + DE-list APIs used by the request/response IPC handlers in main.js.
//
// sfmc-dataloader is pure ESM, so it is pulled in through a cached dynamic
// import from this CommonJS module. Nothing here ever returns a client secret
// to the renderer: `loadConfig` maps the on-disk config into a sanitized shape
// (credential + business-unit names/MIDs only). Persisting a connection is NOT
// done here — that runs as an INIT job in the isolated worker so credentials
// stay off the OS process table (see src/worker/worker.mjs).

/**
 * Cache holder for the lazily-imported ESM module. A mutable property on a const
 * object keeps unicorn/no-top-level-assignment-in-function happy while still
 * memoising the dynamic import.
 *
 * @type {{ promise: Promise.<typeof import('sfmc-dataloader')> | null }}
 */
const cache = { promise: null };

/**
 * Loads (and caches) the pure-ESM sfmc-dataloader module.
 *
 * @returns {Promise.<typeof import('sfmc-dataloader')>}
 */
function loadDataloader() {
    cache.promise ??= import('sfmc-dataloader');
    return cache.promise;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertProjectRoot(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Select a project folder first.');
    }
    return value;
}

/**
 * Reads the project's config pair and returns a sanitized view: every credential
 * with its business units. Secrets are never read here (only `.mcdatarc.json`,
 * never the auth file), so nothing sensitive can leak to the renderer.
 *
 * A missing/partial config is the normal first-run state, not a hard failure —
 * it resolves to `{ configured: false, message }` so the screen can show a
 * friendly hint instead of an error.
 *
 * @param {string} projectRoot
 * @returns {Promise.<{configured: boolean, credentials: {credential: string, eid: (number | undefined), businessUnits: {name: string, mid: (number | string)}[]}[], message: string}>}
 */
async function loadConfig(projectRoot) {
    assertProjectRoot(projectRoot);
    const dl = await loadDataloader();
    try {
        // Swallow the "mcdata superseded by mcdev" notice — it is informational
        // and would otherwise be logged to the main process console.
        const { mcdevrc } = dl.loadProjectConfig(projectRoot, { stderr: () => {} });
        const credentials = Object.entries(mcdevrc.credentials ?? {}).map(
            ([credential, block]) => ({
                credential,
                eid: block?.eid,
                businessUnits: Object.entries(block?.businessUnits ?? {}).map(([name, mid]) => ({
                    name,
                    mid,
                })),
            }),
        );
        return { configured: true, credentials, message: '' };
    } catch (ex) {
        return {
            configured: false,
            credentials: [],
            message: ex?.message ?? String(ex),
        };
    }
}

/**
 * Retrieves the Data Extension list for a credential/BU via a live authenticated
 * SOAP call. Because it actually authenticates, a successful result also proves
 * the saved credentials work — the UI uses it as a "test connection".
 *
 * @param {{ projectRoot?: string, credential?: string, bu?: string }} payload
 * @returns {Promise.<{ok: boolean, items?: {name: string, key: string}[], error?: string}>}
 */
async function fetchDeList(payload) {
    try {
        const projectRoot = assertProjectRoot(payload?.projectRoot);
        const credential = payload?.credential;
        if (typeof credential !== 'string' || credential.length === 0) {
            throw new Error('A credential name is required.');
        }
        const bu = payload?.bu;
        if (typeof bu !== 'string' || bu.length === 0) {
            throw new Error('A business unit is required.');
        }
        const dl = await loadDataloader();
        const items = await dl.fetchDeList(projectRoot, credential, bu);
        return { ok: true, items };
    } catch (ex) {
        return { ok: false, error: ex?.message ?? String(ex) };
    }
}

module.exports = { loadConfig, fetchDeList };
