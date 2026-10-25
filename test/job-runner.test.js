'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// The renderer scripts are plain IIFEs (no bundler, no CommonJS) that attach
// their API to `globalThis`. To exercise JobRunner in Node we run ui.js and
// job-runner.js inside a vm context whose global object carries a tiny DOM stub
// and a fake `mcdata` bridge — just enough surface for the runner to build its
// DOM and drive one job through the job:* event stream.

/**
 * Minimal classList stand-in backed by a Set.
 */
class FakeClassList {
    #set = new Set();

    /**
     * @param {string} name
     * @returns {void}
     */
    add(name) {
        this.#set.add(name);
    }

    /**
     * @param {string} name
     * @returns {void}
     */
    remove(name) {
        this.#set.delete(name);
    }

    /**
     * @param {string} name
     * @param {boolean} [force]
     * @returns {void}
     */
    toggle(name, force) {
        const on = force === undefined ? !this.#set.has(name) : force;
        if (on) {
            this.#set.add(name);
        } else {
            this.#set.delete(name);
        }
    }

    /**
     * @param {string} name
     * @returns {boolean}
     */
    contains(name) {
        return this.#set.has(name);
    }
}

/**
 * Minimal DOM node stand-in covering the handful of properties the renderer UI
 * helpers and JobRunner touch (class/text/attribute/append/listeners/etc.).
 */
class FakeNode {
    parent;
    /**
     * @param {string} tag
     */
    constructor(tag) {
        this.tagName = tag;
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.attributes = new Map();
        this.style = {};
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.clientHeight = 200;
        this.hidden = false;
        this.classList = new FakeClassList();
        this.listeners = new Map();
    }

    /**
     * @returns {FakeNode | undefined}
     */
    get firstElementChild() {
        return this.children.at(0);
    }

    /**
     * @param {string} key
     * @param {string} value
     * @returns {void}
     */
    setAttribute(key, value) {
        this.attributes.set(key, String(value));
    }

    /**
     * @param {string} key
     * @returns {string | undefined}
     */
    getAttribute(key) {
        return this.attributes.get(key);
    }

    /**
     * @param {string} key
     * @returns {void}
     */
    removeAttribute(key) {
        this.attributes.delete(key);
    }

    /**
     * @param {...FakeNode} kids
     * @returns {void}
     */
    append(...kids) {
        for (const child of kids) {
            if (child.tagName === 'fragment') {
                this.append(...child.children);
                child.children = [];
            } else {
                child.parent = this;
                this.children.push(child);
            }
        }
    }

    /**
     * @returns {void}
     */
    replaceChildren() {
        this.children = [];
    }

    /**
     * @returns {void}
     */
    remove() {
        if (this.parent) {
            this.parent.children = this.parent.children.filter((node) => node !== this);
        }
    }

    /**
     * @param {string} event
     * @param {() => void} handler
     * @returns {void}
     */
    addEventListener(event, handler) {
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(handler);
        this.listeners.set(event, bucket);
    }
}

/**
 * Builds a fake `window.mcdata` bridge whose job:* subscriptions capture their
 * handlers so a test can drive the runner through the event stream via emit().
 *
 * @returns {Record<string, any>}
 */
function makeFakeBridge() {
    const emitters = { log: [], progress: [], complete: [], error: [] };
    const bridge = {
        startCalls: [],
        cancelCalls: [],
        startJob(job) {
            bridge.startCalls.push(job);
            return Promise.resolve({ jobId: 'job-1' });
        },
        cancelJob(jobId) {
            bridge.cancelCalls.push(jobId);
        },
        onJobLog(handler) {
            emitters.log.push(handler);
            return () => {
                for (const bucket of Object.values(emitters)) {
                    const index = bucket.indexOf(handler);
                    if (index !== -1) {
                        bucket.splice(index, 1);
                    }
                }
            };
        },
        onJobProgress(handler) {
            emitters.progress.push(handler);
            return () => {
                for (const bucket of Object.values(emitters)) {
                    const index = bucket.indexOf(handler);
                    if (index !== -1) {
                        bucket.splice(index, 1);
                    }
                }
            };
        },
        onJobComplete(handler) {
            emitters.complete.push(handler);
            return () => {
                for (const bucket of Object.values(emitters)) {
                    const index = bucket.indexOf(handler);
                    if (index !== -1) {
                        bucket.splice(index, 1);
                    }
                }
            };
        },
        onJobError(handler) {
            emitters.error.push(handler);
            return () => {
                for (const bucket of Object.values(emitters)) {
                    const index = bucket.indexOf(handler);
                    if (index !== -1) {
                        bucket.splice(index, 1);
                    }
                }
            };
        },
        emit(stream, payload) {
            const handlers = emitters[stream] ?? [];
            for (const handler of handlers) {
                handler(payload);
            }
        },
    };
    return bridge;
}

/**
 * Loads the renderer IIFE scripts into a fresh vm context wired to the DOM stub
 * and fake bridge, and returns the constructed JobRunner plus the fake mcdata.
 *
 * @returns {{ runner: any, mcdata: Record<string, any> }}
 */
function loadJobRunner() {
    const mcdata = makeFakeBridge();
    const document = {
        body: new FakeNode('body'),
        createElement: (tag) => new FakeNode(tag),
        createDocumentFragment: () => new FakeNode('fragment'),
        // JobRunner builds its own DOM and never looks anything up; return
        // nothing so ui.js's toast lookups fall through to creating a container.
        querySelector() {},
    };

    const scheduled = new Map();
    let timerId = 0;
    const sandbox = {
        document,
        mcdata,
        setTimeout,
        clearTimeout,
    };
    // Only the runner's timers are deterministic; ui.js toast timers stay unchanged.
    const flush = () => {
        for (const [id, callback] of scheduled) {
            scheduled.delete(id);
            callback();
        }
    };
    vm.createContext(sandbox);

    const scriptFiles = ['ui.js', 'job-runner.js'];
    for (const scriptFile of scriptFiles) {
        const code = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'renderer', scriptFile),
            'utf8',
        );
        vm.runInContext(code, sandbox, { filename: scriptFile });
    }

    sandbox.setTimeout = (callback, delay) => {
        if (delay !== 16) {
            return setTimeout(callback, delay);
        }
        scheduled.set(++timerId, callback);
        return timerId;
    };
    sandbox.clearTimeout = (id) => {
        scheduled.delete(id);
    };
    return { runner: new sandbox.JobRunner(), mcdata, flush, scheduled };
}

/**
 * Locates the Cancel button inside the runner's DOM tree (controls is the
 * `.job-controls` child of root; the button is its first child).
 *
 * @param {FakeNode} root
 * @returns {FakeNode | undefined}
 */
function findCancelButton(root) {
    const controls = root.children.find((child) => child.className === 'job-controls');
    return controls && controls.firstElementChild;
}

test('bursts retain bounded recent output, batch writes, respect scrolling and flush at completion', async () => {
    const { runner, mcdata, flush, scheduled } = loadJobRunner();
    const pending = runner.start({ kind: 'export' });
    await new Promise((resolve) => setImmediate(resolve));
    const log = runner.element.children.find((node) => node.className === 'job-log');
    log.scrollHeight = 2000;
    log.scrollTop = 100;
    for (let batch = 0; batch < 5; batch++) {
        for (let index = 0; index < 3000; index++) {
            mcdata.emit('log', { jobId: 'job-1', level: 'info', line: `${batch}:${index}` });
        }
        assert.equal(scheduled.size, 1);
        flush();
        assert.ok(log.children.length <= 1000);
        assert.ok(
            log.children.reduce((bytes, node) => bytes + node.textContent.length * 2, 0) <=
                512 * 1024,
        );
        assert.equal(log.scrollTop, 100, 'reading earlier output must not force the tail');
    }
    assert.equal(log.children.at(-1).textContent, '4:2999\n');
    assert.equal(
        runner.element.children.find((node) => node.textContent.startsWith('Older output')).hidden,
        false,
    );
    for (let batch = 0; batch < 4; batch++) {
        for (let index = 0; index < 100; index++) {
            mcdata.emit('log', { jobId: 'job-1', level: 'info', line: 'b'.repeat(9000) });
        }
        flush();
        assert.ok(log.children.length <= 1000);
        if (batch > 1) {
            assert.ok(log.children.length <= 64, 'displayed byte budget evicts below the node cap');
        }
        assert.ok(
            log.children.reduce((bytes, node) => bytes + node.textContent.length * 2, 0) <=
                512 * 1024,
        );
    }
    log.scrollTop = 1800;
    mcdata.emit('log', { jobId: 'job-1', level: 'warn', line: 'x'.repeat(100_000) + 'LATEST' });
    mcdata.emit('complete', { jobId: 'job-1', exitCode: 0 });
    const outcome = await pending;
    assert.equal(outcome.ok, true);
    assert.equal(scheduled.size, 0);
    assert.ok(log.children.at(-1).textContent.length * 2 <= 8192);
    assert.ok(log.children.at(-1).textContent.endsWith('LATEST\n'));
    assert.equal(log.scrollTop, 2000);
    runner.reset();
    flush();
    assert.equal(log.children.length, 0);
});

test('pre-ack log bursts are bounded without losing progress or terminal replay', async () => {
    const { runner, mcdata, scheduled } = loadJobRunner();
    const { promise, resolve } = Promise.withResolvers();
    mcdata.startJob = () => promise;
    const pending = runner.start({ kind: 'export' });
    for (let index = 0; index < 5000; index++) {
        mcdata.emit('log', { jobId: 'job-1', level: 'info', line: 'z'.repeat(100_000) + index });
    }
    mcdata.emit('progress', { jobId: 'job-1', event: { phase: 'exported', records: 12 } });
    mcdata.emit('complete', { jobId: 'job-1', exitCode: 0 });
    assert.equal(scheduled.size, 0);
    resolve({ jobId: 'job-1' });
    const outcome = await pending;
    assert.equal(outcome.ok, true);
    const log = runner.element.children.find((node) => node.className === 'job-log');
    assert.ok(log.children.length <= 32, '256 KiB pre-ack and pending byte budgets');
    assert.ok(log.children.at(-1).textContent.endsWith('4999\n'));
    assert.equal(scheduled.size, 0);
    // Use a distinct id as real main-process jobs do, so inert old fake subscriptions cannot match.
    mcdata.startJob = async () => ({ jobId: 'job-2' });
    const second = runner.start({ kind: 'export' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(log.children.length, 0);
    mcdata.emit('complete', { jobId: 'job-2', exitCode: 0 });
    await second;
});

test('start rejection is visible and startup prevents reentry', async () => {
    const { runner, mcdata } = loadJobRunner();
    const { promise, reject: rejectStart } = Promise.withResolvers();
    mcdata.startJob = () => promise;
    const pending = runner.start({ kind: 'export' });
    assert.equal(runner.isRunning, true);
    const rejected = await runner.start({ kind: 'export' });
    assert.equal(rejected.ok, false);
    runner.reset();
    rejectStart(new Error('Another job is stopping'));
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(runner.isRunning, false);
    const status = runner.element.children.find((node) => node.className === 'job-status muted');
    assert.match(status.textContent, /Could not start: Another job is stopping/);
});

test('terminal and progress events before start acknowledgement are replayed once', async () => {
    const { runner, mcdata } = loadJobRunner();
    mcdata.startJob = async () => {
        mcdata.emit('complete', { jobId: 'other', exitCode: 0 });
        mcdata.emit('log', { jobId: 'job-1', level: 'info', line: 'early' });
        mcdata.emit('progress', { jobId: 'job-1', event: { phase: 'exported', records: 10 } });
        mcdata.emit('complete', { jobId: 'job-1', exitCode: 0 });
        mcdata.emit('error', { jobId: 'job-1', message: 'late' });
        return { jobId: 'job-1' };
    };
    const outcome = await runner.start({ kind: 'export' });
    assert.equal(outcome.ok, true);
    assert.equal(runner.isRunning, false);
    const status = runner.element.children.find((node) => node.className === 'job-status muted');
    assert.equal(status.textContent, 'Completed successfully.');
});

test('cancellation failure and delayed exit remain retryable without reporting completion', async () => {
    const { runner, mcdata } = loadJobRunner();
    const pending = runner.start({ kind: 'import' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mcdata.cancelJob = async () => false;
    await runner.cancel();
    const status = runner.element.children.find((node) => node.className === 'job-status muted');
    assert.match(status.textContent, /Could not stop worker/);
    assert.equal(runner.isRunning, true);
    assert.equal(findCancelButton(runner.element).getAttribute('disabled'), undefined);
    mcdata.cancelJob = async () => true;
    await runner.cancel();
    assert.match(status.textContent, /still waiting for worker exit/);
    assert.match(status.textContent, /not rollback/);
    assert.equal(runner.isRunning, true);
    mcdata.emit('complete', { jobId: 'job-1', cancelled: true });
    const outcome = await pending;
    assert.equal(outcome.cancelled, true);
    assert.match(status.textContent, /may still finish remotely/);
});

test('a freshly constructed JobRunner is idle (regression: isRunning must be false)', () => {
    const { runner } = loadJobRunner();
    // Guard against the #jobId sentinel drift: the field starts as `undefined`,
    // so isRunning compared it against `null` and wrongly reported a run in
    // progress — which made every screen's "already running?" guard swallow the
    // very first Start click.
    assert.equal(runner.isRunning, false);
});

test('streaming upload replaces determinate download progress and supports legacy totals', async () => {
    const { parseProgressLine } = require('../src/shared/parse-progress');
    const { runner, mcdata } = loadJobRunner();
    const pending = runner.start({ kind: 'import', deKeys: ['DE_1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fill = runner.element.firstElementChild.firstElementChild;
    // eslint-disable-next-line unicorn/better-dom-traversing -- FakeNode exposes children, not DOM selectors.
    const status = runner.element.children[1];
    const progress = (line) =>
        mcdata.emit('progress', { jobId: 'job-1', event: parseProgressLine(line) });

    progress('Downloading batch 3 of 4 (7500 records so far)');
    assert.equal(fill.style.width, '75%');
    assert.equal(fill.classList.contains('indeterminate'), false);
    assert.equal(status.textContent, 'Downloading batch 3/4 (7500 records)');

    progress('Uploading batch 1');
    assert.equal(status.textContent, 'Uploading batch 1');
    assert.equal(fill.classList.contains('indeterminate'), true);
    assert.equal(fill.style.width, '40%', 'stale 75% fill must be replaced by animated width');

    progress('Uploading batch 2');
    assert.equal(status.textContent, 'Uploading batch 2');
    assert.equal(fill.classList.contains('indeterminate'), true);

    progress('Uploading batch 2 of 4');
    assert.equal(status.textContent, 'Uploading batch 2/4');
    assert.equal(fill.classList.contains('indeterminate'), false);
    assert.equal(fill.style.width, '50%');

    mcdata.emit('complete', { jobId: 'job-1', exitCode: 0 });
    const outcome = await pending;
    assert.equal(outcome.ok, true);
});

test('nonzero unverified completion never displays success', async () => {
    const { runner, mcdata } = loadJobRunner();
    const pending = runner.start({ kind: 'import' });
    await new Promise((resolve) => setImmediate(resolve));
    mcdata.emit('log', {
        jobId: 'job-1',
        level: 'warn',
        line: 'Import completion is unverified; submitted work may still run remotely. No rollback occurred.',
    });
    mcdata.emit('complete', { jobId: 'job-1', exitCode: 1 });
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    const status = runner.element.children.find((node) => node.className === 'job-status muted');
    assert.equal(status.textContent, 'Finished with exit code 1.');
    assert.equal(runner.isRunning, false);
});

test('start() marks the runner running and enables the cancel button', async () => {
    const { runner, mcdata } = loadJobRunner();

    const pending = runner.start({ kind: 'export', deKeys: ['DE_1'] });
    // Let the awaited startJob() microtask settle so start() records the jobId.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(runner.isRunning, true);
    assert.deepEqual(mcdata.startCalls, [{ kind: 'export', deKeys: ['DE_1'] }]);

    const cancelButton = findCancelButton(runner.element);
    assert.ok(cancelButton, 'cancel button should exist in the runner DOM');
    assert.equal(cancelButton.getAttribute('disabled'), undefined, 'cancel button must be enabled');

    // Complete the job so the awaited outcome resolves and state resets.
    mcdata.emit('complete', { jobId: 'job-1', exitCode: 0 });
    const outcome = await pending;
    assert.equal(outcome.ok, true);
    assert.equal(runner.isRunning, false);
    assert.equal(cancelButton.getAttribute('disabled'), 'true');
});
