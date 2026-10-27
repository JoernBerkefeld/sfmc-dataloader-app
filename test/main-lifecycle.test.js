'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CHANNELS } = require('../src/shared/channels');

function emitter() {
    const handlers = new Map();
    return {
        on(name, handler) {
            const listeners = handlers.get(name) ?? [];
            listeners.push(handler);
            handlers.set(name, listeners);
        },
        once(name, handler) {
            const listeners = handlers.get(name) ?? [];
            listeners.push(handler);
            handlers.set(name, listeners);
        },
        removeListener(name, handler) {
            const listeners = handlers.get(name) ?? [];
            handlers.set(
                name,
                listeners.filter((listener) => listener !== handler),
            );
        },
        emit(name, ...arguments_) {
            const listeners = handlers.get(name) ?? [];
            for (const handler of listeners) {
                handler(...arguments_);
            }
        },
    };
}

async function setup(configOverride) {
    const workers = [];
    const prompts = [];
    const handlers = new Map();
    const telemetry = {
        lifecycle: [],
        cleared: 0,
        disposed: 0,
        firstConsentedRun: false,
        saved: false,
        outcomes: [],
        actions: [],
        revision: 0,
        consent: true,
    };
    const app = {
        ...emitter(),
        isPackaged: true,
        quits: 0,
        whenReady: async () => {},
        getVersion: () => '0.6.1',
        getPath: () => 'F:/Temp',
        getLocale: () => 'en',
        requestSingleInstanceLock: () => true,
        quit() {
            let isPrevented = false;
            app.emit('before-quit', {
                preventDefault() {
                    isPrevented = true;
                },
            });
            if (!isPrevented) {
                app.quits++;
            }
        },
    };
    const win = {
        ...emitter(),
        webContents: { isDestroyed: () => false, send() {} },
        removeMenu() {},
        loadFile() {},
    };
    class BrowserWindow {
        static getAllWindows() {
            return [win];
        }
        constructor() {
            return win;
        }
    }
    const electron = {
        app,
        BrowserWindow,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        dialog: {
            showMessageBox: (...arguments_) => {
                const deferred = Promise.withResolvers();
                prompts.push({ ...deferred, options: arguments_.at(-1) });
                return deferred.promise;
            },
        },
        utilityProcess: {
            fork() {
                const child = {
                    ...emitter(),
                    messages: [],
                    kills: 0,
                    killResult: true,
                    postMessage(message) {
                        child.messages.push(message);
                    },
                    kill() {
                        child.kills++;
                        return child.killResult;
                    },
                };
                workers.push(child);
                return child;
            },
        },
    };
    const filename = path.resolve(__dirname, '../src/main/main.js');
    const localRequire = createRequire(filename);
    const load = (file, overrides = {}) => {
        const sandbox = {
            require: (name) =>
                name === 'electron' ? electron : (overrides[name] ?? localRequire(name)),
            module: { exports: {} },
            __dirname: path.dirname(file),
            process,
            setTimeout() {},
            performance,
        };
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
        return sandbox.module.exports;
    };
    const fakeUpdater = {
        ...emitter(),
        installCalls: 0,
        quitAndInstall() {
            fakeUpdater.installCalls++;
            app.quit();
        },
    };
    const { UpdaterService } = localRequire('./updater');
    const managerPath = path.join(path.dirname(filename), 'job-manager.js');
    const managerModule = load(managerPath);
    load(filename, {
        './job-manager': managerModule,
        './config-service': configOverride ?? localRequire('./config-service'),
        './updater': {
            UpdaterService: class extends UpdaterService {
                constructor(getContents, options) {
                    super(getContents, { ...options, updater: fakeUpdater });
                }
            },
        },
        './settings-store': {
            SettingsStore: class {
                getState() {
                    return { transferDefaults: { debug: false } };
                }
                async setTransferDefaults(value) {
                    return {
                        transferDefaults: value,
                        persistence: { saved: false, error: 'Could not write app settings.' },
                    };
                }
                async setConsent(value) {
                    return {
                        consent: value && telemetry.saved,
                        firstConsentedRun: telemetry.firstConsentedRun && telemetry.saved,
                        persistence: { saved: telemetry.saved },
                    };
                }
                async init() {
                    return {};
                }
            },
        },
        './analytics': {
            Analytics: class {
                trackLifecycle(event) {
                    telemetry.lifecycle.push(event);
                }
                clearPending() {
                    telemetry.cleared++;
                }
                dispose() {
                    telemetry.disposed++;
                }
                trackExport() {}
                trackLoaderVersion() {}
                beginOperation() {
                    return telemetry.consent ? telemetry.revision : undefined;
                }
                acceptsOperation(revision) {
                    return revision !== undefined && revision === this.beginOperation();
                }
                trackJobOutcome(info) {
                    telemetry.outcomes.push(info);
                }
                trackActionOutcome(info, revision) {
                    if (this.acceptsOperation(revision)) {
                        telemetry.actions.push(info);
                    }
                }
            },
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const invoke = (name, payload) => handlers.get(name)({}, payload);
    const close = () => {
        let isPrevented = false;
        win.emit('close', {
            preventDefault() {
                isPrevented = true;
            },
        });
        return isPrevented;
    };
    return { app, prompts, workers, invoke, close, fakeUpdater, telemetry };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const outcome of ['success', 'worker_error', 'worker_exit', 'cancelled']) {
    test(`job telemetry records one consent-bound terminal ${outcome}`, async () => {
        const h = await setup();
        const { jobId } = h.invoke(CHANNELS.JOB_START, { kind: 'export' });
        const worker = h.workers[0];
        switch (outcome) {
            case 'success': {
                worker.emit('message', { type: 'complete', exitCode: 0 });
                break;
            }
            case 'worker_error': {
                worker.emit('message', {
                    type: 'error',
                    message: 'SECRET/path/customer',
                    stack: 'SECRET',
                });
                break;
            }
            case 'cancelled': {
                const cancelling = h.invoke(CHANNELS.JOB_CANCEL, jobId);
                h.prompts[0].resolve({ response: 1 });
                await flush();
                worker.emit('exit', 0);
                await cancelling;
                break;
            }
            // No default
        }
        worker.emit('exit', 1);
        worker.emit('exit', 1);
        worker.emit('message', { type: 'error', message: 'late' });
        assert.equal(h.telemetry.outcomes.length, 1);
        const event = h.telemetry.outcomes[0];
        const expected = {
            success: 'success',
            cancelled: 'cancelled',
            worker_error: 'error',
            worker_exit: 'error',
        };
        assert.equal(event.result, expected[outcome]);
        assert.ok(event.durationMs >= 0);
        assert.equal(JSON.stringify(event).includes('SECRET'), false);
    });
}

test('job activity starting without consent or spanning withdrawal is never replayed', async () => {
    const h = await setup();
    h.telemetry.consent = false;
    h.invoke(CHANNELS.JOB_START, { kind: 'export' });
    h.telemetry.consent = true;
    h.workers[0].emit('exit', 0);
    h.invoke(CHANNELS.JOB_START, { kind: 'export' });
    h.telemetry.revision++;
    h.workers[1].emit('exit', 0);
    assert.equal(h.telemetry.outcomes.length, 0);
});

test('start failure and config/discovery failures cover the actual IPC boundaries', async () => {
    const h = await setup();
    h.invoke(CHANNELS.JOB_START, { kind: 'export' });
    assert.throws(() => h.invoke(CHANNELS.JOB_START, { kind: 'init' }));
    assert.equal(h.telemetry.outcomes[0].errorCategory, 'start_failed');
    await assert.rejects(() => h.invoke(CHANNELS.CONFIG_LOAD, ''));
    await h.invoke(CHANNELS.CONFIG_FETCH_DE_LIST, {});
    assert.deepEqual(
        h.telemetry.actions.map((item) => [item.action, item.result]),
        [
            ['config_load', 'error'],
            ['de_discovery', 'error'],
        ],
    );
    assert.equal(h.telemetry.actions[0].isMcdevProject, false);
    assert.equal(h.telemetry.actions[1].buCount, 1);
});

test('config/discovery success uses real IPC results and counts without customer values', async () => {
    const h = await setup({
        loadConfig: async () => ({
            configured: true,
            credentials: [
                { credential: 'SECRET', businessUnits: [{ name: 'SECRET', mid: 123_456 }] },
            ],
        }),
        fetchDeList: async () => ({ ok: true, items: [{ key: 'SECRET' }] }),
    });
    await h.invoke(CHANNELS.CONFIG_LOAD, __dirname);
    await h.invoke(CHANNELS.CONFIG_FETCH_DE_LIST, { projectRoot: __dirname });
    assert.deepEqual(
        h.telemetry.actions.map((item) => item.result),
        ['success', 'success'],
    );
    assert.equal(h.telemetry.actions[0].buCount, 1);
    assert.equal(JSON.stringify(h.telemetry.actions).includes('SECRET'), false);
});

test('config request spanning a new consent decision is discarded', async () => {
    const deferred = Promise.withResolvers();
    const h = await setup({ loadConfig: () => deferred.promise });
    const pending = h.invoke(CHANNELS.CONFIG_LOAD, __dirname);
    h.telemetry.revision++;
    deferred.resolve({ configured: true, credentials: [] });
    await pending;
    assert.deepEqual(h.telemetry.actions, []);
});

test('will-quit synchronously disposes telemetry without a network drain', async () => {
    const { app, telemetry } = await setup();
    app.emit('will-quit');
    assert.equal(telemetry.disposed, 1);
});

test('settings IPC forwards safe-default choices and truthful persistence results', async () => {
    const { invoke } = await setup();
    const initial = invoke(CHANNELS.SETTINGS_GET);
    assert.equal(initial.transferDefaults.debug, false);
    const result = await invoke(CHANNELS.SETTINGS_SET_TRANSFER_DEFAULTS, { debug: true });
    assert.equal(result.transferDefaults.debug, true);
    assert.equal(result.persistence.saved, false);
    assert.equal(result.persistence.error, 'Could not write app settings.');
});

test('consent IPC clears queued telemetry and records only the first saved consenting run', async () => {
    const { invoke, telemetry } = await setup();
    telemetry.lifecycle.length = 0;
    telemetry.firstConsentedRun = true;
    await invoke(CHANNELS.SETTINGS_SET_CONSENT, true);
    assert.deepEqual(telemetry.lifecycle, []);
    telemetry.saved = true;
    await invoke(CHANNELS.SETTINGS_SET_CONSENT, true);
    assert.deepEqual(telemetry.lifecycle, ['first-consented-run']);
    telemetry.firstConsentedRun = false;
    await invoke(CHANNELS.SETTINGS_SET_CONSENT, false);
    await invoke(CHANNELS.SETTINGS_SET_CONSENT, true);
    assert.deepEqual(telemetry.lifecycle, ['first-consented-run']);
    assert.equal(telemetry.cleared, 4);
});

for (const action of ['close', 'quit', 'cancel', 'update']) {
    test(`${action} requires native confirmation and reserves starts until worker exit`, async () => {
        const h = await setup();
        const { jobId } = h.invoke(CHANNELS.JOB_START, { kind: 'export' });
        if (action === 'update') {
            h.fakeUpdater.emit('update-downloaded', { version: '1.0.0' });
        }
        const trigger = () => {
            if (action === 'close') {
                return h.close();
            }
            if (action === 'quit') {
                return h.app.quit();
            }
            return h.invoke(
                action === 'cancel' ? CHANNELS.JOB_CANCEL : CHANNELS.UPDATE_INSTALL,
                jobId,
            );
        };
        trigger();
        assert.equal(h.prompts.length, 1);
        assert.equal(h.prompts[0].options.defaultId, 0);
        assert.equal(h.prompts[0].options.cancelId, 0);
        assert.match(h.prompts[0].options.detail, /Remote work.*may continue/);
        assert.equal(h.workers[0].kills, 0);
        assert.throws(() => h.invoke(CHANNELS.JOB_START, { kind: 'init' }), /confirmation/);
        trigger();
        assert.equal(h.prompts.length, 1);
        h.prompts[0].resolve({ response: 0 });
        await flush();
        assert.equal(h.app.quits, 0);
        assert.equal(h.fakeUpdater.installCalls, 0);
        assert.equal(h.workers[0].kills, 0);
        const result = trigger();
        h.prompts[1].resolve({ response: 1 });
        await flush();
        // A pending worker must not receive a start after cancellation was accepted.
        h.workers[0].emit('message', { type: 'ready' });
        assert.equal(h.workers[0].messages.length, 0);
        assert.equal(h.workers[0].kills, 1);
        assert.equal(h.app.quits, 0);
        assert.equal(h.fakeUpdater.installCalls, 0);
        assert.throws(() => h.invoke(CHANNELS.JOB_START, {}), /confirmation/);
        h.workers[0].emit('exit', 0);
        await result;
        await flush();
        assert.equal(h.fakeUpdater.installCalls, action === 'update' ? 1 : 0);
        assert.equal(h.app.quits, action === 'cancel' ? 0 : 1);
        if (action === 'cancel') {
            h.invoke(CHANNELS.JOB_START, { kind: 'export' });
        } else {
            assert.throws(() => h.invoke(CHANNELS.JOB_START, {}), /confirmation/);
        }
    });
}

for (const failure of ['denied kill', 'throwing kill', 'dialog failure', 'natural exit']) {
    test(`close safely handles ${failure} during confirmation`, async () => {
        const h = await setup();
        h.invoke(CHANNELS.JOB_START, { kind: 'export' });
        h.close();
        switch (failure) {
            case 'denied kill': {
                h.workers[0].killResult = false;

                break;
            }
            case 'throwing kill': {
                h.workers[0].kill = () => {
                    throw new Error('kill failed');
                };

                break;
            }
            case 'natural exit': {
                h.workers[0].emit('exit', 0);

                break;
            }
            // No default
        }
        if (failure === 'dialog failure') {
            h.prompts[0].reject(new Error('dialog failed'));
        } else {
            h.prompts[0].resolve({ response: 1 });
        }
        await flush();
        assert.equal(h.app.quits, failure === 'natural exit' ? 1 : 0);
        if (failure !== 'natural exit') {
            assert.throws(() => h.invoke(CHANNELS.JOB_START, {}), /still starting/);
            h.workers[0].emit('exit', 0);
            h.invoke(CHANNELS.JOB_START, { kind: 'export' });
        }
    });
}

test('idle quit/install need no interruption prompt; unknown cancellation cannot stop a job', async () => {
    const h = await setup();
    assert.equal(h.invoke(CHANNELS.UPDATE_INSTALL), false);
    const { jobId } = h.invoke(CHANNELS.JOB_START, { kind: 'export' });
    assert.equal(h.invoke(CHANNELS.JOB_CANCEL, 'not-owned'), false);
    assert.equal(h.workers[0].kills, 0);
    assert.equal(h.prompts.length, 0);
    h.workers[0].emit('exit', 0);
    assert.equal(h.invoke(CHANNELS.JOB_CANCEL, jobId), false);
    h.fakeUpdater.emit('update-downloaded', { version: '1.0.0' });
    assert.equal(await h.invoke(CHANNELS.UPDATE_INSTALL), true);
    assert.equal(h.fakeUpdater.installCalls, 1);
    assert.equal(h.app.quits, 1);
    assert.equal(h.prompts.length, 0);
});
