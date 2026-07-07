'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    stringifyConsoleArgs,
    captureConsole,
    createJobRunner,
} = require('../src/shared/run-mcdata-job');

/**
 * Builds a fake console object with no-op methods, so a test can hand it to
 * captureConsole/createJobRunner without touching the real console.
 *
 * @returns {{ log: Function, info: Function, warn: Function, error: Function }}
 */
function fakeConsole() {
    return { log() {}, info() {}, warn() {}, error() {} };
}

/**
 * Returns a `{ posted, post }` pair: `post` is a plain (void) collector so it
 * satisfies `unicorn/no-return-array-push` (arrow bodies must not return the
 * `.push()` result).
 *
 * @returns {{ posted: object[], post: (message: object) => void }}
 */
function collector() {
    const posted = [];
    return {
        posted,
        post(message) {
            posted.push(message);
        },
    };
}

test('stringifyConsoleArgs joins mixed argument types with spaces', () => {
    assert.equal(stringifyConsoleArgs(['a', 1, true]), 'a 1 true');
    assert.equal(stringifyConsoleArgs([]), '');
    assert.equal(stringifyConsoleArgs(['only']), 'only');
});

test('captureConsole forwards each console level and derives progress, then restores', () => {
    const { posted, post } = collector();
    const target = fakeConsole();
    const originalWarn = target.warn;

    const restore = captureConsole(target, post);

    // A plain info line → one log message, no progress.
    target.info('just a log line');
    // A progress-shaped line → a log message AND a derived progress event.
    target.log('17:04:12 info: Uploading batch 2 of 4');
    // warn/error map to their levels.
    target.warn('careful');
    target.error('boom');

    assert.deepEqual(posted, [
        { type: 'log', level: 'info', line: 'just a log line' },
        { type: 'log', level: 'info', line: '17:04:12 info: Uploading batch 2 of 4' },
        { type: 'progress', event: { phase: 'upload', current: 2, total: 4, ratio: 0.5 } },
        { type: 'log', level: 'warn', line: 'careful' },
        { type: 'log', level: 'error', line: 'boom' },
    ]);

    restore();
    assert.equal(target.warn, originalWarn, 'restore must put the original methods back');
});

test('runJob streams logs incrementally then completes with the mcdata exit code', async () => {
    const { posted, post } = collector();
    const target = fakeConsole();

    let logsAtImportTime = -1;
    const runJob = createJobRunner({
        post,
        buildArgv: () => ['node', 'mcdata', 'export', 'MyOrg/Parent'],
        importDataloader: async () => ({
            main(argv) {
                assert.deepEqual(argv, ['node', 'mcdata', 'export', 'MyOrg/Parent']);
                // Emit many lines to show forwarding is incremental (not buffered
                // to the end) and bounded — nothing accumulates in the runner.
                for (let index = 1; index <= 1000; index += 1) {
                    target.info(
                        `Downloading batch ${index} of 1000 (${index * 10} records so far)`,
                    );
                }
                // By the time main() is still running, the parent has already
                // received all those messages — proof of streaming.
                logsAtImportTime = posted.length;
                return 0;
            },
        }),
        console: target,
    });

    await runJob({ kind: 'export' });

    assert.ok(logsAtImportTime >= 2000, 'logs+progress must be forwarded during main(), not after');

    const complete = posted.at(-1);
    assert.deepEqual(complete, { type: 'complete', exitCode: 0 });

    // 1000 lines → 1000 log + 1000 progress + 1 complete.
    assert.equal(posted.filter((m) => m.type === 'log').length, 1000);
    assert.equal(posted.filter((m) => m.type === 'progress').length, 1000);
});

test('runJob reports a non-numeric exit code as 0', async () => {
    const { posted, post } = collector();
    const runJob = createJobRunner({
        post,
        buildArgv: () => ['node', 'mcdata'],
        importDataloader: async () => ({ main: () => {} }),
        console: fakeConsole(),
    });
    await runJob({ kind: 'export' });
    assert.deepEqual(posted.at(-1), { type: 'complete', exitCode: 0 });
});

test('runJob reports a non-zero mcdata exit code verbatim', async () => {
    const { posted, post } = collector();
    const runJob = createJobRunner({
        post,
        buildArgv: () => ['node', 'mcdata'],
        importDataloader: async () => ({ main: () => 1 }),
        console: fakeConsole(),
    });
    await runJob({ kind: 'import' });
    assert.deepEqual(posted.at(-1), { type: 'complete', exitCode: 1 });
});

test('runJob turns a thrown mcdata error into an error message', async () => {
    const { posted, post } = collector();
    const target = fakeConsole();
    const originalLog = target.log;
    const runJob = createJobRunner({
        post,
        buildArgv: () => ['node', 'mcdata'],
        importDataloader: async () => ({
            main() {
                throw new Error('auth failed');
            },
        }),
        console: target,
    });

    await runJob({ kind: 'import' });

    const last = posted.at(-1);
    assert.equal(last.type, 'error');
    assert.equal(last.message, 'auth failed');
    assert.ok(typeof last.stack === 'string' && last.stack.length > 0);
    // The console must be restored even on the error path.
    assert.equal(target.log, originalLog);
});

test('runJob surfaces an argv-building error without importing sfmc-dataloader', async () => {
    const { posted, post } = collector();
    let isImported = false;
    const runJob = createJobRunner({
        post,
        buildArgv: () => {
            throw new Error('bad job');
        },
        importDataloader: async () => {
            isImported = true;
            return { main: () => 0 };
        },
        console: fakeConsole(),
    });

    await runJob({ kind: 'nonsense' });

    assert.equal(isImported, false, 'must not import the loader when argv building fails');
    assert.deepEqual(posted.length, 1);
    assert.equal(posted[0].type, 'error');
    assert.equal(posted[0].message, 'bad job');
});
