'use strict';

/**
 * @typedef {object} ProgressEvent
 * @property {'download'|'upload'|'exported'|'imported'|'rowCount'} phase
 * @property {number} [current] - current batch (1-based) when known
 * @property {number} [total] - total batches when known
 * @property {number} [records] - record/row count associated with the line
 * @property {number} [ratio] - current/total in [0,1] when both are known
 * @property {'before'|'after'} [when] - for rowCount lines
 */

// sfmc-dataloader emits deterministic, timestamped `log.info` lines. We parse
// the message tail (after "info: ") to derive structured progress without
// coupling to any private API. Patterns mirror the strings in
// sfmc-dataloader/lib/{config,import-de,export-de,cli}.mjs.
const PATTERNS = {
    downloadPaged: /Downloading batch (\d+) of (\d+) \((\d+) records so far\)/,
    downloadUnpaged: /Downloading next batch \(currently (\d+) records\)/,
    upload: /Uploading batch (\d+) of (\d+)/,
    exported: /Exported: .* \((\d+) rows\)/,
    imported: /Imported: .* \((\d+) rows\)/,
    rowCountBefore: /Row count before import: (\d+)/,
    rowCountAfter: /Row count after import: (\d+)/,
};

/**
 * Strips the `HH:MM:SS level: ` prefix that sfmc-dataloader prepends so the
 * pattern matchers only see the message body.
 *
 * @param {string} line
 * @returns {string}
 */
function stripLogPrefix(line) {
    return line.replace(/^\d{2}:\d{2}:\d{2}\s+(?:info|warn|error):\s*/, '');
}

/**
 * Parses a single log line into a structured progress event, or null when the
 * line carries no recognizable progress signal.
 *
 * @param {string} line
 * @returns {ProgressEvent | null}
 */
function parseProgressLine(line) {
    if (typeof line !== 'string' || line.length === 0) {
        return null;
    }
    const body = stripLogPrefix(line);

    const paged = PATTERNS.downloadPaged.exec(body);
    if (paged) {
        const current = Number(paged[1]);
        const total = Number(paged[2]);
        return {
            phase: 'download',
            current,
            total,
            records: Number(paged[3]),
            ratio: total > 0 ? Math.min(1, current / total) : undefined,
        };
    }

    const unpaged = PATTERNS.downloadUnpaged.exec(body);
    if (unpaged) {
        return { phase: 'download', records: Number(unpaged[1]) };
    }

    const upload = PATTERNS.upload.exec(body);
    if (upload) {
        const current = Number(upload[1]);
        const total = Number(upload[2]);
        return {
            phase: 'upload',
            current,
            total,
            ratio: total > 0 ? Math.min(1, current / total) : undefined,
        };
    }

    const exported = PATTERNS.exported.exec(body);
    if (exported) {
        return { phase: 'exported', records: Number(exported[1]) };
    }

    const imported = PATTERNS.imported.exec(body);
    if (imported) {
        return { phase: 'imported', records: Number(imported[1]) };
    }

    const before = PATTERNS.rowCountBefore.exec(body);
    if (before) {
        return { phase: 'rowCount', when: 'before', records: Number(before[1]) };
    }

    const after = PATTERNS.rowCountAfter.exec(body);
    if (after) {
        return { phase: 'rowCount', when: 'after', records: Number(after[1]) };
    }

    return null;
}

module.exports = { parseProgressLine };
