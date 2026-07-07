'use strict';

// Pure helpers for reasoning about import file sizes. Dependency- and
// side-effect-free so the Electron main process, Node tests, AND the sandboxed
// renderer can all reuse them without duplicating logic.
//
// The renderer loads plain <script> files (no bundler, no require), so the
// bottom of this file also attaches the same API to `globalThis.McFileSize`.
// Under Node/CommonJS `module` exists and we export normally; in the browser
// `module` is undefined and only the global attach runs.
//
// Imports always stream through sfmc-dataloader's asynchronous bulk API, so RAM
// usage stays bounded regardless of file size. The "guard" is therefore about
// setting user expectations — very large files take a long time and need the app
// to stay open on a stable connection — not about routing to a different code
// path.

/** Files at or above this many bytes trigger a blocking confirmation. 1 GiB. */
const LARGE_FILE_WARN_BYTES = 1024 * 1024 * 1024;

/**
 * Formats a byte count as a human-readable string (binary units: KB = 1024 B).
 *
 * @param {number} bytes
 * @returns {string} e.g. "0 B", "512 B", "1.4 MB", "2.75 GB"
 */
function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
        return '0 B';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    // One decimal below 10, two below 100, none above — compact but useful.
    const decimals = value < 10 ? 2 : value < 100 ? 1 : 0;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * @typedef {object} SizedFile
 * @property {string} path
 * @property {number} size - size in bytes (0 when unknown)
 */

/**
 * Summarizes a list of sized files: total size, the single largest file, and
 * whether any file crosses the large-file warning threshold.
 *
 * @param {SizedFile[]} files
 * @returns {{
 *   count: number,
 *   totalBytes: number,
 *   totalText: string,
 *   largestBytes: number,
 *   hasLargeFile: boolean,
 *   largeFiles: SizedFile[],
 * }}
 */
function summarizeFiles(files) {
    const list = Array.isArray(files) ? files : [];
    let totalBytes = 0;
    let largestBytes = 0;
    const largeFiles = [];
    for (const file of list) {
        const size = file && typeof file.size === 'number' && file.size > 0 ? file.size : 0;
        totalBytes += size;
        if (size > largestBytes) {
            largestBytes = size;
        }
        if (size >= LARGE_FILE_WARN_BYTES) {
            largeFiles.push(file);
        }
    }
    return {
        count: list.length,
        totalBytes,
        totalText: formatBytes(totalBytes),
        largestBytes,
        hasLargeFile: largeFiles.length > 0,
        largeFiles,
    };
}

/**
 * Builds the confirmation message shown before starting an import that includes
 * one or more very large files. Returns an empty string when no confirmation is
 * needed (no file crosses the threshold).
 *
 * @param {SizedFile[]} files
 * @returns {string}
 */
function buildLargeFileWarning(files) {
    const summary = summarizeFiles(files);
    if (!summary.hasLargeFile) {
        return '';
    }
    const biggest = formatBytes(summary.largestBytes);
    const total = summary.totalText;
    return (
        `You are about to import ${summary.count} file(s) totalling ${total} ` +
        `(largest ${biggest}).\n\n` +
        'Large imports stream to Marketing Cloud in batches and can take a long ' +
        'time. Keep this app open and stay connected until the job finishes.\n\n' +
        'Continue?'
    );
}

const api = { LARGE_FILE_WARN_BYTES, formatBytes, summarizeFiles, buildLargeFileWarning };

/**
 * Attaches the API to a global-like object. Written as a helper taking the
 * target as a parameter so the sandboxed renderer can expose `McFileSize`
 * without a bundler (mirrors the `(function(globalObject){…})(globalThis)`
 * pattern used by the other renderer scripts).
 *
 * @param {Record<string, unknown>} target
 * @returns {void}
 */
function attachGlobal(target) {
    target.McFileSize = api;
}

if (typeof module === 'object' && module.exports) {
    // CommonJS: main process + Node tests require this module.
    module.exports = api;
} else if (typeof globalThis !== 'undefined') {
    // Sandboxed renderer loads this as a plain <script>; expose the helpers.
    attachGlobal(globalThis);
}
