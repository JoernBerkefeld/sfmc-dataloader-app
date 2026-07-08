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

/** No-op unsubscribe returned by the fake event subscriptions. */
const noopUnsubscribe = () => {};

/** Minimal classList stand-in backed by a Set. */
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
    /** @param {string} tag */
    constructor(tag) {
        this.tagName = tag;
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.attributes = new Map();
        this.style = {};
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.hidden = false;
        this.classList = new FakeClassList();
        this.listeners = new Map();
    }

    /** @returns {FakeNode | undefined} */
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
        this.children.push(...kids);
    }

    /** @returns {void} */
    replaceChildren() {
        this.children = [];
    }

    /** @returns {void} */
    remove() {}

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
            return noopUnsubscribe;
        },
        onJobProgress(handler) {
            emitters.progress.push(handler);
            return noopUnsubscribe;
        },
        onJobComplete(handler) {
            emitters.complete.push(handler);
            return noopUnsubscribe;
        },
        onJobError(handler) {
            emitters.error.push(handler);
            return noopUnsubscribe;
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
        // JobRunner builds its own DOM and never looks anything up; return
        // nothing so ui.js's toast lookups fall through to creating a container.
        querySelector() {},
    };

    const sandbox = { document, mcdata, setTimeout, clearTimeout };
    vm.createContext(sandbox);

    const scriptFiles = ['ui.js', 'job-runner.js'];
    for (const scriptFile of scriptFiles) {
        const code = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'renderer', scriptFile),
            'utf8',
        );
        vm.runInContext(code, sandbox, { filename: scriptFile });
    }

    return { runner: new sandbox.JobRunner(), mcdata };
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

test('a freshly constructed JobRunner is idle (regression: isRunning must be false)', () => {
    const { runner } = loadJobRunner();
    // Guard against the #jobId sentinel drift: the field starts as `undefined`,
    // so isRunning compared it against `null` and wrongly reported a run in
    // progress — which made every screen's "already running?" guard swallow the
    // very first Start click.
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
