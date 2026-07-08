'use strict';

// The telemetry "PII firewall". Every analytics event is shaped here, and this
// module is deliberately PURE (no I/O, no Electron, no network) so it can be unit
// tested in isolation and so the set of fields that can ever leave the machine is
// auditable in one place.
//
// Design rules enforced here:
//   1. Event params are ONLY counts, coarse buckets, enums, and booleans — never
//      free text derived from user input (no file names, BU names, credential
//      names, folder paths, or file contents).
//   2. Continuous/high-cardinality values (byte sizes, row counts, DE counts) are
//      collapsed into coarse buckets so a value can never identify a specific
//      data set.
//   3. Locale is reduced to the primary language subtag (e.g. `en-US` -> `en`)
//      and only rides along on OPT-IN usage events — never on the mandatory
//      lifecycle pings.
//   4. sanitizeParams() is the final gate: anything that is not a string/number/
//      boolean is dropped, and strings are length-capped, before a payload is
//      built.

/**
 * GA4 event names. Lifecycle events are mandatory; usage events are opt-in.
 *
 * Uninstalls are intentionally NOT tracked with an event: there is no reliable,
 * privacy-friendly, cross-platform uninstall hook, so churn is inferred from the
 * absence of `app_launch` pings instead (a client that stops pinging is treated
 * as inactive/uninstalled). See PRIVACY.md.
 */
const EVENTS = {
    // Mandatory lifecycle (no consent required, no locale attached).
    APP_INSTALL: 'app_install',
    APP_UPDATE: 'app_update',
    APP_LAUNCH: 'app_launch',
    // Optional usage (only sent with explicit opt-in consent).
    EXPORT_USED: 'export_used',
    IMPORT_USED: 'import_used',
    JOB_OUTCOME: 'job_outcome',
};

/** Allowed export/import file formats; anything else normalises to 'other'. */
const FORMATS = new Set(['csv', 'tsv', 'json']);

/** Allowed job outcomes. */
const RESULTS = new Set(['success', 'error', 'cancelled']);

/** Coarse job-kind enum values reported to analytics. */
const KINDS = new Set(['export', 'export_multi_bu', 'import', 'import_cross_bu', 'init']);

const MAX_STRING_LENGTH = 64;

/**
 * Reduces a BCP-47 locale to its lowercase primary language subtag so region and
 * variant (which raise cardinality and fingerprinting risk) are dropped.
 * `en-US` -> `en`, `pt-BR` -> `pt`, unknown/empty -> `unknown`.
 *
 * @param {unknown} locale
 * @returns {string}
 */
function normalizeLocale(locale) {
    if (typeof locale !== 'string' || locale.length === 0) {
        return 'unknown';
    }
    const primary = locale.toLowerCase().split(/[-_]/, 1)[0];
    return /^[a-z]{2,3}$/.test(primary) ? primary : 'unknown';
}

/**
 * Normalises a file format to one of the allowed enum values.
 *
 * @param {unknown} format
 * @returns {'csv'|'tsv'|'json'|'other'}
 */
function normalizeFormat(format) {
    return typeof format === 'string' && FORMATS.has(format) ? format : 'other';
}

/**
 * Normalises a job result to one of the allowed enum values.
 *
 * @param {unknown} result
 * @returns {'success'|'error'|'cancelled'|'unknown'}
 */
function normalizeResult(result) {
    return typeof result === 'string' && RESULTS.has(result) ? result : 'unknown';
}

/**
 * Maps a worker JOB_KIND value onto the coarse analytics kind enum.
 *
 * @param {unknown} kind
 * @returns {'export'|'export_multi_bu'|'import'|'import_cross_bu'|'init'|'unknown'}
 */
function normalizeKind(kind) {
    switch (kind) {
        case 'export': {
            return 'export';
        }
        case 'exportMultiBu': {
            return 'export_multi_bu';
        }
        case 'import': {
            return 'import';
        }
        case 'importCrossBu': {
            return 'import_cross_bu';
        }
        case 'init': {
            return 'init';
        }
        default: {
            return KINDS.has(kind) ? /** @type {string} */ (kind) : 'unknown';
        }
    }
}

/**
 * Derives the coarse install channel from the runtime environment. Kept pure and
 * fully parameterised so it is testable without Electron. Detection order favours
 * the more specific packaging markers before falling back to the platform's
 * default self-updating installer.
 *
 * @param {object} [runtime]
 * @param {string} [runtime.platform] - process.platform
 * @param {Record<string, string | undefined>} [runtime.env] - process.env
 * @param {boolean} [runtime.windowsStore] - process.windowsStore
 * @returns {string}
 */
function installChannel(runtime = {}) {
    if (runtime.windowsStore === true) {
        return 'windows_store';
    }
    const environment = runtime.env ?? {};
    if (typeof environment.APPIMAGE === 'string' && environment.APPIMAGE.length > 0) {
        return 'appimage';
    }
    if (typeof environment.SNAP === 'string' && environment.SNAP.length > 0) {
        return 'snap';
    }
    if (typeof environment.FLATPAK_ID === 'string' && environment.FLATPAK_ID.length > 0) {
        return 'flatpak';
    }
    switch (runtime.platform) {
        case 'win32': {
            return 'nsis';
        }
        case 'darwin': {
            return 'dmg';
        }
        case 'linux': {
            // deb/rpm are not reliably distinguishable at runtime; report the
            // coarse "linux_other" bucket for any non-AppImage/snap/flatpak Linux.
            return 'linux_other';
        }
        default: {
            return 'unknown';
        }
    }
}

/**
 * Collapses a byte size into a coarse, non-identifying bucket.
 *
 * @param {unknown} bytes
 * @returns {string}
 */
function sizeBucket(bytes) {
    const value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (value === 0) {
        return '0';
    }
    const KB = 1024;
    const MB = 1024 * KB;
    if (value < MB) {
        return '<1MB';
    }
    if (value < 10 * MB) {
        return '1-10MB';
    }
    if (value < 100 * MB) {
        return '10-100MB';
    }
    const GB = 1024 * MB;
    if (value < GB) {
        return '100MB-1GB';
    }
    if (value < 10 * GB) {
        return '1-10GB';
    }
    return '>10GB';
}

/**
 * Collapses a row count into a coarse bucket.
 *
 * @param {unknown} count
 * @returns {string}
 */
function rowCountBucket(count) {
    const value = typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    if (value === 0) {
        return '0';
    }
    if (value <= 100) {
        return '1-100';
    }
    if (value <= 1000) {
        return '101-1K';
    }
    if (value <= 10_000) {
        return '1K-10K';
    }
    if (value <= 100_000) {
        return '10K-100K';
    }
    if (value <= 1_000_000) {
        return '100K-1M';
    }
    return '>1M';
}

/**
 * Collapses a count of Data Extensions into a coarse bucket.
 *
 * @param {unknown} count
 * @returns {string}
 */
function deCountBucket(count) {
    const value = typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    if (value === 0) {
        return '0';
    }
    if (value === 1) {
        return '1';
    }
    if (value <= 5) {
        return '2-5';
    }
    if (value <= 20) {
        return '6-20';
    }
    if (value <= 50) {
        return '21-50';
    }
    return '>50';
}

/**
 * Final safety gate. Copies only string/number/boolean values, drops everything
 * else, and caps string length so no long free-text value can slip through even
 * if a caller passes one by mistake.
 *
 * @param {Record<string, unknown>} parameters
 * @returns {Record<string, string | number | boolean>}
 */
function sanitizeParameters(parameters) {
    /** @type {Record<string, string | number | boolean>} */
    const safe = {};
    if (!parameters || typeof parameters !== 'object') {
        return safe;
    }
    for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
            safe[key] = value;
        } else if (typeof value === 'string') {
            safe[key] = value.slice(0, MAX_STRING_LENGTH);
        }
        // objects / arrays / null / undefined are intentionally dropped
    }
    return safe;
}

/**
 * Builds the params for a mandatory lifecycle event (install/update/launch).
 * Deliberately excludes locale.
 *
 * @param {object} info
 * @param {string} info.appVersion
 * @param {string} info.platform - process.platform (os)
 * @param {string} [info.osVersion]
 * @param {string} [info.arch] - process.arch
 * @param {string} [info.channel] - install channel
 * @returns {Record<string, string | number | boolean>}
 */
function buildLifecycleParameters(info) {
    return sanitizeParameters({
        app_version: info.appVersion,
        os: info.platform,
        os_version: info.osVersion,
        arch: info.arch,
        install_channel: info.channel,
    });
}

/**
 * Builds the params for the opt-in `export_used` event.
 *
 * @param {object} info
 * @param {string} info.appVersion
 * @param {unknown} info.format
 * @param {number} info.deCount - number of DEs exported in this job
 * @param {boolean} [info.multiBu]
 * @param {unknown} [info.locale]
 * @returns {Record<string, string | number | boolean>}
 */
function buildExportParameters(info) {
    return sanitizeParameters({
        app_version: info.appVersion,
        format: normalizeFormat(info.format),
        de_count_bucket: deCountBucket(info.deCount),
        multi_bu: Boolean(info.multiBu),
        locale: normalizeLocale(info.locale),
    });
}

/**
 * Builds the params for the opt-in `import_used` event.
 *
 * @param {object} info
 * @param {string} info.appVersion
 * @param {unknown} info.format
 * @param {number} info.deCount - number of target DEs (across BUs)
 * @param {number} [info.fileCount] - number of files imported
 * @param {number} [info.totalBytes] - total size of imported files
 * @param {'upsert'|'insert'|string} [info.mode]
 * @param {boolean} [info.crossBu]
 * @param {unknown} [info.locale]
 * @returns {Record<string, string | number | boolean>}
 */
function buildImportParameters(info) {
    return sanitizeParameters({
        app_version: info.appVersion,
        format: normalizeFormat(info.format),
        de_count_bucket: deCountBucket(info.deCount),
        file_count_bucket: deCountBucket(info.fileCount),
        size_bucket: sizeBucket(info.totalBytes),
        mode: info.mode === 'insert' ? 'insert' : 'upsert',
        cross_bu: Boolean(info.crossBu),
        locale: normalizeLocale(info.locale),
    });
}

/**
 * Builds the params for the opt-in `job_outcome` event.
 *
 * @param {object} info
 * @param {string} info.appVersion
 * @param {unknown} info.kind
 * @param {unknown} info.result - success/error/cancelled
 * @param {number} [info.rowCount] - peak row count observed for the job
 * @param {unknown} [info.locale]
 * @returns {Record<string, string | number | boolean>}
 */
function buildJobOutcomeParameters(info) {
    return sanitizeParameters({
        app_version: info.appVersion,
        kind: normalizeKind(info.kind),
        result: normalizeResult(info.result),
        row_count_bucket: rowCountBucket(info.rowCount),
        locale: normalizeLocale(info.locale),
    });
}

module.exports = {
    EVENTS,
    FORMATS,
    RESULTS,
    KINDS,
    normalizeLocale,
    normalizeFormat,
    normalizeResult,
    normalizeKind,
    installChannel,
    sizeBucket,
    rowCountBucket,
    deCountBucket,
    sanitizeParams: sanitizeParameters,
    buildLifecycleParams: buildLifecycleParameters,
    buildExportParams: buildExportParameters,
    buildImportParams: buildImportParameters,
    buildJobOutcomeParams: buildJobOutcomeParameters,
};
