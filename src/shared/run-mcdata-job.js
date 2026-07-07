'use strict';

// Orchestration for running a single sfmc-dataloader job. Extracted from
// worker.mjs so the streamed-log forwarding and the outcome protocol
// (ready → start → complete/error) can be unit-tested without Electron's
// utilityProcess or a live SFMC connection.
//
// Every environment-specific dependency is injected:
//   - `post`            → posts a structured message to the parent
//   - `buildArgv`       → structured job → mcdata argv
//   - `importDataloader`→ dynamic import of the ESM sfmc-dataloader package
//   - `console`         → the console object whose output is captured/forwarded
//
// sfmc-dataloader surfaces every operational message through `log.*`, which
// writes to the console. We forward each line to the parent *as it arrives*
// rather than buffering, so memory stays bounded regardless of how many
// progress lines a multi-GB export/import produces.

const { parseProgressLine } = require('./parse-progress');

/**
 * Coerces console arguments to a single space-joined string, matching how the
 * worker relays sfmc-dataloader's log output to the parent process.
 *
 * @param {unknown[]} arguments_
 * @returns {string}
 */
function stringifyConsoleArguments(arguments_) {
    return arguments_.map((value) => (typeof value === 'string' ? value : String(value))).join(' ');
}

/**
 * Posts a captured log line and, when it encodes progress, a derived progress
 * event as well.
 *
 * @param {(message: object) => void} post
 * @param {'info'|'warn'|'error'} level
 * @param {string} line
 * @returns {void}
 */
function forwardLine(post, level, line) {
    post({ type: 'log', level, line });
    const progress = parseProgressLine(line);
    if (progress) {
        post({ type: 'progress', event: progress });
    }
}

/**
 * Replaces the log/info/warn/error methods on `target` with forwarders that
 * relay each line to `post`. Returns a function that restores the originals.
 *
 * @param {object} target - a console-like object
 * @param {(message: object) => void} post
 * @returns {() => void} restore function
 */
function captureConsole(target, post) {
    const original = {
        log: target.log,
        info: target.info,
        warn: target.warn,
        error: target.error,
    };
    const forward =
        (level) =>
        (...arguments_) =>
            forwardLine(post, level, stringifyConsoleArguments(arguments_));
    target.log = forward('info');
    target.info = forward('info');
    target.warn = forward('warn');
    target.error = forward('error');
    return () => Object.assign(target, original);
}

/**
 * Builds the single-job runner used by the worker. All environment-specific
 * dependencies are injected so the orchestration is unit-testable without
 * Electron or a live SFMC connection.
 *
 * @param {object} deps
 * @param {(message: object) => void} deps.post - send a message to the parent
 * @param {(job: object) => string[]} deps.buildArgv - structured job → argv
 * @param {() => Promise.<{main: (argv: string[]) => (number | Promise.<number>)}>} deps.importDataloader
 * @param {object} deps.console - console-like object whose output is captured
 * @returns {(job: object) => Promise.<void>} runJob
 */
function createJobRunner({ post, buildArgv, importDataloader, console: target }) {
    return async function runJob(job) {
        let argv;
        try {
            argv = buildArgv(job);
        } catch (ex) {
            post({ type: 'error', message: ex?.message ?? String(ex), stack: ex?.stack });
            return;
        }

        const restore = captureConsole(target, post);
        try {
            const { main } = await importDataloader();
            const exitCode = await main(argv);
            restore();
            post({ type: 'complete', exitCode: typeof exitCode === 'number' ? exitCode : 0 });
        } catch (ex) {
            restore();
            post({ type: 'error', message: ex?.message ?? String(ex), stack: ex?.stack });
        }
    };
}

module.exports = {
    stringifyConsoleArgs: stringifyConsoleArguments,
    forwardLine,
    captureConsole,
    createJobRunner,
};
