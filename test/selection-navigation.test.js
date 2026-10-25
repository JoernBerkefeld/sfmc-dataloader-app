'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Node {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.textContent = options.text ?? '';
        this.className = options.class ?? '';
        this.style = {};
        this.children = [];
        this.listeners = {};
        this.checked = false;
        this.hidden = false;
        this.dataset = {};
        this.classList = { toggle() {}, add() {}, remove() {} };
        this._value = '';
    }
    get value() {
        return this._value || (this.tag === 'select' ? (this.firstElementChild?.value ?? '') : '');
    }
    set value(value) {
        this._value = value;
    }
    get firstElementChild() {
        return this.children.at(0);
    }
    get options() {
        return this.children;
    }
    append(...nodes) {
        this.children.push(...nodes);
    }
    replaceChildren() {
        this.children = [];
        this._value = '';
    }
    addEventListener(event, handler) {
        (this.listeners[event] ??= []).push(handler);
    }
    async emit(event) {
        const handlers = this.listeners[event] ?? [];
        for (const handler of handlers) {
            await handler();
        }
    }
    dispatchEvent(event) {
        void this.emit(event.type);
    }
    setAttribute() {}
    removeAttribute() {}
    querySelectorAll() {
        return descendants(this).filter((node) => node.tag === 'input' && node.checked);
    }
}

function descendants(node) {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function deferred() {
    const { promise, resolve } = Promise.withResolvers();
    return { promise, resolve };
}

function setup() {
    const nodes = [];
    const listeners = new Set();
    let projectRoot = 'F:/A';
    const element = (tag, options) => {
        const node = new Node(tag, options);
        nodes.push(node);
        return node;
    };
    const context = vm.createContext({
        McUI: { element, toast() {}, clear: (node) => node.replaceChildren() },
        McForms: {
            field: (_label, child) => {
                const node = element('field');
                node.append(child);
                return node;
            },
            input: () => element('input'),
            button: (text) => element('button', { text }),
            checkbox: (_label, checked) => {
                const input = element('input');
                input.checked = checked;
                return { input, wrap: element('check') };
            },
            directoryPicker: () => ({ input: element('input'), wrap: element('picker') }),
        },
        McState: {
            get: () => ({ projectRoot }),
            set: (patch) => {
                projectRoot = patch.projectRoot;
                for (const listener of listeners) {
                    listener({ projectRoot });
                }
            },
            subscribe: (handler) => {
                listeners.add(handler);
                return () => listeners.delete(handler);
            },
        },
        McConnectionData: {
            listCredBuOptions: async () => [],
            listDeItems: async () => ({ ok: true, items: [] }),
        },
        mcdata: { JOB_KIND: {}, getSettings: async () => ({ consent: false }) },
    });
    const load = (file) =>
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8'),
            context,
            { filename: file },
        );
    return { context, nodes, listeners, element, load };
}

for (const newestFirst of [true, false]) {
    test(`BU picker ignores stale project responses, newest first: ${newestFirst}`, async () => {
        const { context, nodes, load } = setup();
        const first = deferred();
        const second = deferred();
        context.McConnectionData.listCredBuOptions = (root) =>
            root === 'F:/A' ? first.promise : second.promise;
        load('bu-picker.js');
        const picker = new context.McBuPicker();
        context.McState.set({ projectRoot: 'F:/B' });
        assert.equal(picker.getValue(), '');
        const answerA = () => first.resolve([{ value: 'Org/A', label: 'A' }]);
        const answerB = () => second.resolve([{ value: 'Org/B', label: 'B' }]);
        (newestFirst ? answerB : answerA)();
        await new Promise(setImmediate);
        (newestFirst ? answerA : answerB)();
        await new Promise(setImmediate);
        assert.equal(picker.getValue(), 'Org/B');
        assert.equal(nodes.find((node) => node.tag === 'select').children.length, 2);
        picker.dispose();
    });

    test(`DE selector invalidates A to B and ignores stale results, newest first: ${newestFirst}`, async () => {
        const { context, nodes, load, listeners } = setup();
        let bu = 'Org/A';
        let mode = 'single';
        const pending = [];
        context.McConnectionData.listDeItems = () => {
            const response = deferred();
            pending.push(response);
            return response.promise;
        };
        load('de-selector.js');
        const selector = new context.McDeSelector({ getCredBu: () => bu, getContext: () => mode });
        const button = nodes.find((node) => node.tag === 'button');
        const a = button.emit('click');
        bu = 'Org/B';
        selector.invalidate();
        assert.throws(() => selector.getKeys(), /current project/);
        const b = button.emit('click');
        const answer = (index, key) =>
            pending[index].resolve({ ok: true, items: [{ key, name: key }] });
        answer(newestFirst ? 1 : 0, newestFirst ? 'B' : 'A');
        await new Promise(setImmediate);
        answer(newestFirst ? 0 : 1, newestFirst ? 'A' : 'B');
        await Promise.all([a, b]);
        const checklist = nodes.find((node) => node.className === 'de-checklist');
        assert.equal(checklist.children.length, 1);
        checklist.firstElementChild.firstElementChild.checked = true;
        assert.deepEqual([...selector.getKeys()], ['B']);
        mode = 'multi';
        assert.throws(() => selector.getKeys(), /current project/);
        assert.equal(checklist.children.length, 0);
        const modeSelect = nodes.find((node) => node.tag === 'select');
        modeSelect.value = 'manual';
        nodes.find((node) => node.tag === 'textarea').value = 'EXPLICIT';
        assert.deepEqual([...selector.getKeys()], ['EXPLICIT']);
        context.McState.set({ projectRoot: 'F:/C' });
        assert.deepEqual([...selector.getKeys()], ['EXPLICIT']);
        selector.dispose();
        assert.equal(listeners.size, 0);
    });
}

test('directory browse notifies selection dependents immediately', async () => {
    const { context, load } = setup();
    context.Event = class {
        constructor(type) {
            this.type = type;
        }
    };
    context.mcdata.chooseDirectory = async () => 'F:/new-project';
    load('forms.js');
    const picker = context.McForms.directoryPicker();
    let changed = 0;
    picker.input.addEventListener('change', () => changed++);
    await descendants(picker.wrap)
        .find((node) => node.tag === 'button')
        .emit('click');
    assert.equal(picker.input.value, 'F:/new-project');
    assert.equal(changed, 1);
});

test('DE refresh clears selected keys immediately and validates project at submission', async () => {
    const { context, nodes, load } = setup();
    context.McConnectionData.listDeItems = async () => ({
        ok: true,
        items: [{ name: 'A', key: 'A' }],
    });
    load('de-selector.js');
    const selector = new context.McDeSelector({ getCredBu: () => 'Org/A' });
    const button = nodes.find((node) => node.tag === 'button');
    await button.emit('click');
    nodes.find(
        (node) => node.className === 'de-checklist',
    ).firstElementChild.firstElementChild.checked = true;
    assert.deepEqual([...selector.getKeys()], ['A']);
    const response = deferred();
    context.McConnectionData.listDeItems = () => response.promise;
    const loading = button.emit('click');
    assert.throws(() => selector.getKeys(), /current project/);
    context.McState.set({ projectRoot: 'F:/B' });
    response.resolve({ ok: true, items: [{ name: 'OLD', key: 'OLD' }] });
    await loading;
    assert.throws(() => selector.getKeys(), /current project/);
});

test('router retains mounted runners and stable subscriptions over repeated and same-tab navigation', async () => {
    const { context, element, load, listeners } = setup();
    const view = element('view');
    const tabs = ['connections', 'export', 'import', 'settings'].map((name) => {
        const node = element('tab');
        node.dataset.view = name;
        return node;
    });
    const mounts = {};
    const activations = {};
    const runners = {};
    let ready;
    context.document = {
        querySelector: (selector) => (selector === '#view' ? view : undefined),
        querySelectorAll: () => tabs,
        createElement: element,
    };
    context.addEventListener = (_event, handler) => {
        ready = handler;
    };
    context.mcdata.getAppInfo = async () => ({ appVersion: 'test' });
    context.McUpdates = { init() {} };
    context.McSettings = { initConsentGate() {} };
    context.McScreens = {};
    for (const tab of tabs) {
        const name = tab.dataset.view;
        context.McScreens[name] = {
            mount(host) {
                mounts[name] = (mounts[name] ?? 0) + 1;
                context.McState.subscribe(() => {});
                const runner = {
                    active: true,
                    cancel: () => {
                        runner.active = false;
                    },
                };
                runners[name] = runner;
                host.append(runner);
            },
            activate() {
                activations[name] = (activations[name] ?? 0) + 1;
            },
        };
    }
    load('renderer.js');
    await ready();
    for (let index = 0; index < 10; index++) {
        for (const tab of tabs) {
            await tab.emit('click');
            const count = activations[tab.dataset.view];
            await tab.emit('click');
            assert.equal(activations[tab.dataset.view], count);
        }
    }
    assert.equal(view.children.length, 4);
    assert.equal(listeners.size, 5);
    assert.deepEqual(Object.values(mounts), [1, 1, 1, 1]);
    assert.equal(runners.export.active, true);
    runners.export.cancel();
    assert.equal(runners.export.active, false);
    assert.equal(view.children.filter((node) => !node.hidden).length, 1);
});

test('real runner controls and job subscriptions survive navigation until terminal delivery', async () => {
    const { context, element, load } = setup();
    const events = new Map();
    for (const name of ['onJobLog', 'onJobProgress', 'onJobComplete', 'onJobError']) {
        events.set(name, new Set());
        context.mcdata[name] = (handler) => {
            events.get(name).add(handler);
            return () => events.get(name).delete(handler);
        };
    }
    context.mcdata.startJob = async () => ({ jobId: 'active' });
    let cancelled;
    context.mcdata.cancelJob = async (id) => {
        cancelled = id;
        return true;
    };
    load('job-runner.js');
    const view = element('view');
    const tabs = ['connections', 'export'].map((name) => {
        const tab = element('tab');
        tab.dataset.view = name;
        return tab;
    });
    let ready;
    let runner;
    context.document = {
        querySelector: (selector) => (selector === '#view' ? view : undefined),
        querySelectorAll: () => tabs,
        createElement: element,
    };
    context.addEventListener = (_event, handler) => {
        ready = handler;
    };
    context.mcdata.getAppInfo = async () => ({});
    context.McUpdates = { init() {} };
    context.McSettings = { initConsentGate() {} };
    context.McScreens = {
        connections: { mount() {} },
        export: {
            mount(host) {
                runner = new context.JobRunner();
                host.append(runner.element);
            },
        },
    };
    load('renderer.js');
    await ready();
    await tabs[1].emit('click');
    const original = runner;
    const finished = runner.start({});
    await new Promise(setImmediate);
    for (let index = 0; index < 10; index++) {
        await tabs[0].emit('click');
        await tabs[1].emit('click');
        await tabs[1].emit('click');
    }
    assert.equal(runner, original);
    assert.equal(runner.isRunning, true);
    for (const handlers of events.values()) {
        assert.equal(handlers.size, 1);
    }
    for (const handler of events.get('onJobProgress')) {
        handler({
            jobId: 'active',
            event: { phase: 'download', current: 1, total: 2, ratio: 0.5 },
        });
    }
    assert.match(
        descendants(runner.element).find((node) => node.className === 'job-status muted')
            .textContent,
        /Downloading/,
    );
    await descendants(runner.element)
        .find((node) => node.tag === 'button')
        .emit('click');
    assert.equal(cancelled, 'active');
    for (const handler of events.get('onJobComplete')) {
        handler({ jobId: 'active', cancelled: true });
    }
    const outcome = await finished;
    assert.equal(outcome.cancelled, true);
    for (const handlers of events.values()) {
        assert.equal(handlers.size, 0);
    }
});

for (const screen of ['import', 'export']) {
    test(`${screen} wiring clears list on BU change and rejects stale provenance at submission`, async () => {
        const { context, nodes, element, load } = setup();
        const jobs = [];
        const messages = [];
        context.McUI.toast = (message) => {
            messages.push(message);
        };
        context.mcdata.JOB_KIND = { IMPORT: 'import', EXPORT: 'export' };
        context.McFileSize = { buildLargeFileWarning: () => '' };
        context.JobRunner = class {
            element = element('runner');
            async start(job) {
                jobs.push(job);
                return { ok: true };
            }
        };
        context.McConnectionData.listCredBuOptions = async () => [
            { value: 'Org/A', label: 'A' },
            { value: 'Org/B', label: 'B' },
        ];
        context.McConnectionData.listDeItems = async () => ({
            ok: true,
            items: [{ key: 'KEY', name: 'KEY' }],
        });
        for (const file of ['forms.js', 'bu-picker.js', 'de-selector.js', `screens/${screen}.js`]) {
            load(file);
        }
        context.McScreens[screen].mount(element('host'));
        await new Promise(setImmediate);
        const loadButton = nodes.find((node) => node.textContent === 'Load / refresh DE list');
        const runButton = nodes.find((node) => node.textContent === `Start ${screen}`);
        const picker = nodes.find(
            (node) =>
                node.tag === 'select' && node.options.some((option) => option.value === 'Org/A'),
        );
        const checklist = nodes.find((node) => node.className === 'de-checklist');
        await loadButton.emit('click');
        checklist.firstElementChild.firstElementChild.checked = true;
        picker.value = 'Org/B';
        await picker.emit('change');
        assert.equal(checklist.children.length, 0);
        await runButton.emit('click');
        assert.equal(jobs.length, 0);
        await loadButton.emit('click');
        checklist.firstElementChild.firstElementChild.checked = true;
        picker.value = 'Org/A';
        await runButton.emit('click');
        assert.equal(jobs.length, 0);
        assert.match(messages.at(-1), /current project/);
        await loadButton.emit('click');
        checklist.firstElementChild.firstElementChild.checked = true;
        await runButton.emit('click');
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].source, 'Org/A');
    });
}

test('cached settings refresh on activation and ignore an older read after a toggle', async () => {
    const { context, nodes, element, load } = setup();
    let isConsent = false;
    context.mcdata.getSettings = async () => ({ consent: isConsent });
    context.mcdata.setTelemetryConsent = async (value) => ({ consent: value });
    load('screens/settings.js');
    context.McScreens.settings.mount(element('host'));
    await context.McScreens.settings.activate();
    const toggle = nodes.find((node) => node.tag === 'input');
    assert.equal(toggle.checked, false);
    isConsent = true;
    await context.McScreens.settings.activate();
    assert.equal(toggle.checked, true);
    const oldRead = deferred();
    context.mcdata.getSettings = () => oldRead.promise;
    const refreshing = context.McScreens.settings.activate();
    toggle.checked = false;
    await toggle.emit('change');
    oldRead.resolve({ consent: true });
    await refreshing;
    assert.equal(toggle.checked, false);
});

test('cached connections refresh on activation and ignore previous project results', async () => {
    const { context, nodes, element, load } = setup();
    context.JobRunner = class {
        element = element('runner');
    };
    const responses = [];
    context.mcdata.loadConfig = () => {
        const result = deferred();
        responses.push(result);
        return result.promise;
    };
    load('screens/connections.js');
    context.McScreens.connections.mount(element('host'));
    context.McScreens.connections.activate();
    context.McState.set({ projectRoot: 'F:/B' });
    context.McScreens.connections.activate();
    responses[1].resolve({
        configured: true,
        credentials: [{ credential: 'NEW', businessUnits: [] }],
    });
    await new Promise(setImmediate);
    responses[0].resolve({
        configured: true,
        credentials: [{ credential: 'OLD', businessUnits: [] }],
    });
    await new Promise(setImmediate);
    const saved = nodes.find((node) => node.className === 'saved-list');
    assert.equal(saved.children.length, 1);
    assert.equal(saved.firstElementChild.firstElementChild.textContent, 'NEW');
    context.McScreens.connections.activate();
    responses[2].resolve({
        configured: true,
        credentials: [{ credential: 'REFRESHED', businessUnits: [] }],
    });
    await new Promise(setImmediate);
    assert.equal(saved.firstElementChild.firstElementChild.textContent, 'REFRESHED');
});
