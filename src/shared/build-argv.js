'use strict';

const { JOB_KIND } = require('./channels');

/**
 * @typedef {object} McdataJob
 * @property {string} kind - one of JOB_KIND values
 * @property {string} [projectRoot] - project root passed as `-p/--project`
 * @property {string} [source] - `cred/bu` positional (single-BU export/import)
 * @property {string[]} [sources] - `cred/bu` list for multi-BU export (`--from`)
 * @property {string} [from] - `cred/bu` source for cross-BU API import (`--from`)
 * @property {string[]} [to] - `cred/bu` targets for cross-BU import (`--to`)
 * @property {string[]} [deKeys] - Data Extension customer keys (`--de`)
 * @property {string[]} [filePaths] - import file paths (`--file`)
 * @property {'csv'|'tsv'|'json'} [format] - export/import format (default csv)
 * @property {boolean} [jsonPretty] - pretty-print JSON exports (`--json-pretty`)
 * @property {boolean} [git] - stable filenames (`--git`)
 * @property {number} [maxRowsPerFile] - split exports (`--max-rows-per-file`)
 * @property {'upsert'|'insert'} [mode] - import write mode (default upsert)
 * @property {boolean} [backupBeforeImport] - true → `--backup-before-import`,
 * false → `--no-backup-before-import`, undefined → neither
 * @property {boolean} [clearBeforeImport] - SOAP ClearData before import
 * @property {boolean} [debug] - write API debug logs (`--debug`)
 * @property {string} [credential] - init: credential name (`--credential`)
 * @property {string} [clientId] - init: installed-package client_id (`--client-id`)
 * @property {string} [clientSecret] - init: installed-package client_secret (`--client-secret`)
 * @property {string} [authUrl] - init: tenant auth URL (`--auth-url`)
 * @property {string|number} [enterpriseId] - init: enterprise (parent) MID (`--enterprise-id`)
 * @property {boolean} [overwrite] - init: pass `--yes` to overwrite existing config
 */

const FORMATS = new Set(['csv', 'tsv', 'json']);
const MODES = new Set(['upsert', 'insert']);

/**
 * Validates a `cred/bu` token the same way `parseCredBu` does in sfmc-dataloader.
 *
 * @param {unknown} value
 * @param {string} label - used in error messages
 * @returns {string}
 */
function assertCredBu(value, label) {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string in the form <credential>/<businessUnit>`);
    }
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) {
        throw new Error(`${label} must be <credential>/<businessUnit>, got: ${value}`);
    }
    return value;
}

/**
 * @param {unknown} list
 * @param {string} label
 * @returns {string[]}
 */
function assertNonEmptyStringArray(list, label) {
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`${label} requires at least one entry`);
    }
    for (const entry of list) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new Error(`${label} entries must be non-empty strings`);
        }
    }
    return list;
}

/**
 * Appends export-formatting flags shared by single- and multi-BU export jobs.
 *
 * @param {string[]} argv
 * @param {McdataJob} job
 * @returns {void}
 */
function appendExportFormatFlags(argv, job) {
    if (job.format) {
        if (!FORMATS.has(job.format)) {
            throw new Error(`Invalid format "${job.format}" (expected csv, tsv, or json)`);
        }
        argv.push('--format', job.format);
    }
    if (job.jsonPretty) {
        argv.push('--json-pretty');
    }
    if (job.git) {
        argv.push('--git');
    }
    if (job.maxRowsPerFile !== undefined) {
        if (!Number.isSafeInteger(job.maxRowsPerFile) || job.maxRowsPerFile < 1) {
            throw new Error(
                `maxRowsPerFile must be a positive integer, got: ${job.maxRowsPerFile}`,
            );
        }
        argv.push('--max-rows-per-file', String(job.maxRowsPerFile));
    }
}

/**
 * Appends import-behaviour flags shared by single- and cross-BU import jobs.
 * The worker runs non-interactively (no TTY), so a requested clear must always
 * carry the non-interactive risk acknowledgement — the UI is responsible for
 * the typed confirmation before setting `clearBeforeImport`.
 *
 * @param {string[]} argv
 * @param {McdataJob} job
 * @returns {void}
 */
function appendImportFlags(argv, job) {
    if (job.mode) {
        if (!MODES.has(job.mode)) {
            throw new Error(`Invalid mode "${job.mode}" (expected upsert or insert)`);
        }
        argv.push('--mode', job.mode);
    }
    if (job.backupBeforeImport === true) {
        argv.push('--backup-before-import');
    } else if (job.backupBeforeImport === false) {
        argv.push('--no-backup-before-import');
    }
    if (job.clearBeforeImport) {
        argv.push('--clear-before-import', '--i-accept-clear-data-risk');
    }
}

/**
 * Appends `--de <key>` for every provided Data Extension key.
 *
 * @param {string[]} argv
 * @param {string[]} deKeys
 * @returns {void}
 */
function appendDeKeys(argv, deKeys) {
    for (const key of deKeys) {
        argv.push('--de', key);
    }
}

/**
 * Appends `--file <path>` for every provided import file.
 *
 * @param {string[]} argv
 * @param {string[]} filePaths
 * @returns {void}
 */
function appendFilePaths(argv, filePaths) {
    for (const filePath of filePaths) {
        argv.push('--file', filePath);
    }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} is required`);
    }
    return value;
}

/**
 * Appends the `mcdata init` credential flags. These *do* carry the client
 * secret, which is acceptable here — and only here — because the worker runs
 * `main(argv)` in-process (see the note on {@link buildMcdataArgv}); the argv
 * array lives in the worker's heap and is never handed to a shell, so nothing
 * reaches the OS process table.
 *
 * @param {string[]} argv
 * @param {McdataJob} job
 * @returns {void}
 */
function appendInitFlags(argv, job) {
    // Validate every required flag up front so a single push keeps the arg
    // pairs contiguous (and satisfies unicorn/prefer-single-call).
    const credential = assertNonEmptyString(job.credential, 'credential');
    const clientId = assertNonEmptyString(job.clientId, 'clientId');
    const clientSecret = assertNonEmptyString(job.clientSecret, 'clientSecret');
    const authUrl = assertNonEmptyString(job.authUrl, 'authUrl');

    const eid = typeof job.enterpriseId === 'number' ? String(job.enterpriseId) : job.enterpriseId;
    const mid = assertNonEmptyString(eid, 'enterpriseId').trim();
    if (!/^\d+$/.test(mid)) {
        throw new Error(`enterpriseId must be a positive integer, got: ${mid}`);
    }

    argv.push(
        '--credential',
        credential,
        '--client-id',
        clientId,
        '--client-secret',
        clientSecret,
        '--auth-url',
        authUrl,
        '--enterprise-id',
        mid,
    );

    if (job.overwrite) {
        argv.push('--yes');
    }
}

/**
 * Builds the `argv` array passed to `sfmc-dataloader`'s `main(argv)` entry point
 * for a structured job. The first two entries mirror Node's `process.argv`
 * (`[execPath, scriptPath]`) because `main` slices them off internally.
 *
 * For export/import jobs no credentials are ever placed on argv — auth is read
 * from the project's `.mcdatarc.json` / `.mcdata-auth.json` files by the loader
 * itself. The lone exception is `JOB_KIND.INIT`, which necessarily carries the
 * client id/secret so `mcdata init` can create those files. That is safe here
 * because the worker calls `main(argv)` *in-process* (`utilityProcess`, not a
 * shell child process): the argv array stays in the worker's heap and never
 * appears on the OS process table.
 *
 * @param {McdataJob} job
 * @returns {string[]}
 */
function buildMcdataArgv(job) {
    if (!job || typeof job !== 'object') {
        throw new TypeError('job must be an object');
    }
    /** @type {string[]} */
    const argv = ['node', 'mcdata'];

    switch (job.kind) {
        case JOB_KIND.INIT: {
            argv.push('init');
            appendInitFlags(argv, job);
            break;
        }

        case JOB_KIND.EXPORT: {
            argv.push('export', assertCredBu(job.source, 'source'));
            appendDeKeys(argv, assertNonEmptyStringArray(job.deKeys, 'deKeys'));
            appendExportFormatFlags(argv, job);
            break;
        }

        case JOB_KIND.EXPORT_MULTI_BU: {
            argv.push('export');
            for (const source of assertNonEmptyStringArray(job.sources, 'sources')) {
                argv.push('--from', assertCredBu(source, 'sources entry'));
            }
            appendDeKeys(argv, assertNonEmptyStringArray(job.deKeys, 'deKeys'));
            appendExportFormatFlags(argv, job);
            break;
        }

        case JOB_KIND.IMPORT: {
            argv.push('import', assertCredBu(job.source, 'source'));
            const hasDe = Array.isArray(job.deKeys) && job.deKeys.length > 0;
            const hasFile = Array.isArray(job.filePaths) && job.filePaths.length > 0;
            if (hasDe === hasFile) {
                throw new Error('import requires exactly one of deKeys or filePaths');
            }
            if (hasDe) {
                appendDeKeys(argv, job.deKeys);
            } else {
                appendFilePaths(argv, job.filePaths);
            }
            if (job.format) {
                appendExportFormatFlags(argv, { format: job.format });
            }
            appendImportFlags(argv, job);
            break;
        }

        case JOB_KIND.IMPORT_CROSS_BU: {
            argv.push('import');
            const targets = assertNonEmptyStringArray(job.to, 'to');
            const hasFrom = typeof job.from === 'string' && job.from.length > 0;
            const hasFile = Array.isArray(job.filePaths) && job.filePaths.length > 0;
            if (hasFrom && hasFile) {
                throw new Error('cross-BU import cannot combine from (API mode) with filePaths');
            }
            if (!hasFrom && !hasFile) {
                throw new Error('cross-BU import requires either from + deKeys, or filePaths');
            }
            if (hasFrom) {
                argv.push('--from', assertCredBu(job.from, 'from'));
                for (const target of targets) {
                    argv.push('--to', assertCredBu(target, 'to entry'));
                }
                appendDeKeys(argv, assertNonEmptyStringArray(job.deKeys, 'deKeys'));
            } else {
                for (const target of targets) {
                    argv.push('--to', assertCredBu(target, 'to entry'));
                }
                appendFilePaths(argv, job.filePaths);
            }
            if (job.format) {
                appendExportFormatFlags(argv, { format: job.format });
            }
            appendImportFlags(argv, job);
            break;
        }

        default: {
            throw new Error(`Unsupported job kind: ${String(job.kind)}`);
        }
    }

    if (typeof job.projectRoot === 'string' && job.projectRoot.length > 0) {
        argv.push('--project', job.projectRoot);
    }
    if (job.debug) {
        argv.push('--debug');
    }
    return argv;
}

module.exports = { buildMcdataArgv };
