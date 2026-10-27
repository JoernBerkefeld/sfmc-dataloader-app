'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Node {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.id = options.attrs?.id ?? '';
        this.textContent = options.text ?? '';
        this.className = options.class ?? '';
        this.style = {};
        this.children = [];
        this.listeners = {};
        this.checked = false;
        this.hidden = false;
        this.dataset = {};
        this.attributes = {};
        this.focused = false;
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
    setAttribute(name, value) {
        (this.attributes ??= {})[name] = value;
    }
    focus() {
        this.focused = true;
    }
    removeAttribute(name) {
        delete this.attributes[name];
    }
    querySelector(selector) {
        return descendants(this).find((node) => '.' + node.className === selector);
    }
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
            select: (options, selected) => {
                const node = element('select');
                node.value = selected;
                for (const option of options) {
                    const child = element('option');
                    child.value = option.value;
                    node.append(child);
                }
                return node;
            },
            input: (options) => {
                const node = element('input');
                node.type = options?.type ?? 'text';
                return node;
            },
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

test('multi-BU picker searches across credentials, preserves hidden choices and merges manual tokens', async () => {
    const { context, load } = setup();
    context.McConnectionData.listCredBuOptions = async () => [
        { value: 'First/One', label: 'One' },
        { value: 'Second/Two', label: 'Two' },
    ];
    load('bu-picker.js');
    const picker = new context.McBuPicker({ multiple: true });
    await new Promise(setImmediate);
    let changes = 0;
    picker.onChange(() => changes++);
    const choices = () => descendants(picker.element).filter((node) => node.type === 'checkbox');
    choices()[0].checked = true;
    await choices()[0].emit('change');
    const search = descendants(picker.element).find((node) => node.type === 'search');
    // The test form helper intentionally leaves type assignment to the picker.
    const searchInput = search ?? descendants(picker.element).find((node) => node.tag === 'input');
    searchInput.value = 'SECOND';
    await searchInput.emit('input');
    assert.equal(choices().length, 1);
    choices()[0].checked = true;
    await choices()[0].emit('change');
    const manual = descendants(picker.element).find((node) => node.tag === 'textarea');
    manual.value = 'First/One, Third/Three\n ,Third/Three';
    await manual.emit('input');
    assert.deepEqual([...picker.getValues()], ['First/One', 'Second/Two', 'Third/Three']);
    assert.equal(picker.getValue(), 'First/One');
    await picker.refresh();
    assert.deepEqual([...picker.getValues()], ['First/One', 'Second/Two', 'Third/Three']);
    assert.equal(changes, 3);
    context.McState.set({ projectRoot: 'F:/B' });
    assert.deepEqual([...picker.getValues()], []);
    assert.equal(manual.value, '');
    await new Promise(setImmediate);
    assert.deepEqual([...picker.getValues()], []);
    picker.dispose();
});

for (const newestFirst of [true, false]) {
    test(`multi-BU picker rejects stale discovery and disposal responses: ${newestFirst}`, async () => {
        const { context, load } = setup();
        const first = deferred();
        const second = deferred();
        context.McConnectionData.listCredBuOptions = (root) =>
            root === 'F:/A' ? first.promise : second.promise;
        load('bu-picker.js');
        const picker = new context.McBuPicker({ multiple: true });
        context.McState.set({ projectRoot: 'F:/B' });
        const answerA = () => first.resolve([{ value: 'Old/A', label: 'Old' }]);
        const answerB = () => second.resolve([{ value: 'New/B', label: 'New' }]);
        (newestFirst ? answerB : answerA)();
        await new Promise(setImmediate);
        (newestFirst ? answerA : answerB)();
        await new Promise(setImmediate);
        assert.ok(descendants(picker.element).some((node) => node.value === 'New/B'));
        assert.ok(descendants(picker.element).every((node) => node.value !== 'Old/A'));
        const pending = deferred();
        context.McConnectionData.listCredBuOptions = () => pending.promise;
        const refresh = picker.refresh();
        picker.dispose();
        pending.resolve([{ value: 'Disposed/C', label: 'Disposed' }]);
        await refresh;
        assert.ok(descendants(picker.element).every((node) => node.value !== 'Disposed/C'));
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

test('DE refresh blocks submission while loading and validates project at submission', async () => {
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
    assert.throws(() => selector.getKeys(), /finish refreshing/);
    context.McState.set({ projectRoot: 'F:/B' });
    response.resolve({ ok: true, items: [{ name: 'OLD', key: 'OLD' }] });
    await loading;
    assert.throws(() => selector.getKeys(), /current project/);
});

test('DE search matches names and keys, counts hidden selections and clears all', async () => {
    const { context, load } = setup();
    context.McConnectionData.listDeItems = async () => ({
        ok: true,
        items: [
            { name: 'Customers', key: 'KEY_A' },
            { name: 'Orders', key: 'KEY_B' },
            { name: 'Other', key: 'KEY_C' },
        ],
    });
    load('de-selector.js');
    const selector = new context.McDeSelector({ getCredBu: () => 'Org/A' });
    const all = () => descendants(selector.element);
    const action = (name) =>
        all()
            .find((node) => node.textContent === name)
            .emit('click');
    const search = all().find((node) => node.type === 'search');
    const rows = () => all().filter((node) => node.className === 'de-check');
    const count = () => all().find((node) => /selected ·/.test(node.textContent)).textContent;
    await action('Load / refresh DE list');
    search.value = '  CUSTOMERs ';
    await search.emit('input');
    assert.deepEqual(
        rows().map((row) => row.hidden),
        [false, true, true],
    );
    await action('Select visible');
    search.value = 'key_b';
    await search.emit('input');
    await action('Select visible');
    assert.deepEqual([...selector.getKeys()], ['KEY_A', 'KEY_B']);
    assert.equal(count(), '2 selected · 1 of 3 visible');
    search.value = 'no matches';
    await search.emit('input');
    await action('Select visible');
    assert.equal(count(), '2 selected · 0 of 3 visible');
    await action('Clear selection');
    assert.equal(count(), '0 selected · 0 of 3 visible');
    assert.throws(() => selector.getKeys(), /Select at least/);
    search.value = '';
    await search.emit('input');
    rows()[2].firstElementChild.checked = true;
    await rows()[2].firstElementChild.emit('change');
    assert.equal(count(), '1 selected · 3 of 3 visible');
    selector.dispose();
});

for (const newestFirst of [true, false]) {
    test(`DE same-context refresh preserves survivors and rejects older refresh: ${newestFirst}`, async () => {
        const { context, load } = setup();
        let identity = 'single';
        context.McConnectionData.listDeItems = async () => ({
            ok: true,
            items: [
                { name: 'Old A', key: 'A' },
                { name: 'B', key: 'B' },
            ],
        });
        load('de-selector.js');
        const selector = new context.McDeSelector({
            getCredBu: () => 'Org/A',
            getContext: () => identity,
        });
        const all = () => descendants(selector.element);
        const loadList = () =>
            all()
                .find((node) => node.textContent === 'Load / refresh DE list')
                .emit('click');
        await loadList();
        await all()
            .find((node) => node.textContent === 'Select visible')
            .emit('click');
        const first = deferred();
        const second = deferred();
        let call = 0;
        context.McConnectionData.listDeItems = () =>
            call++ === 0 ? first.promise : second.promise;
        const a = loadList();
        const b = loadList();
        assert.throws(() => selector.getKeys(), /finish refreshing/);
        const answerA = () => first.resolve({ ok: true, items: [{ name: 'Old', key: 'B' }] });
        const answerB = () =>
            second.resolve({
                ok: true,
                items: [
                    { name: 'Renamed', key: 'A' },
                    { name: 'New', key: 'C' },
                ],
            });
        (newestFirst ? answerB : answerA)();
        await new Promise(setImmediate);
        (newestFirst ? answerA : answerB)();
        await Promise.all([a, b]);
        assert.deepEqual([...selector.getKeys()], ['A']);
        assert.ok(all().some((node) => node.textContent === 'Renamed (A)'));
        identity = 'multi with complete new sources';
        context.McConnectionData.listDeItems = async () => ({
            ok: true,
            items: [{ name: 'A', key: 'A' }],
        });
        await loadList();
        assert.throws(() => selector.getKeys(), /Select at least/);
        selector.dispose();
    });
}

for (const outcome of ['failed', 'empty', 'disposed', 'context']) {
    test(`DE refresh drops unusable selections after ${outcome} response`, async () => {
        const { context, load } = setup();
        let bu = 'Org/A';
        context.McConnectionData.listDeItems = async () => ({
            ok: true,
            items: [{ name: 'A', key: 'A' }],
        });
        load('de-selector.js');
        const selector = new context.McDeSelector({ getCredBu: () => bu });
        const all = () => descendants(selector.element);
        const loadList = () =>
            all()
                .find((node) => node.textContent === 'Load / refresh DE list')
                .emit('click');
        await loadList();
        await all()
            .find((node) => node.textContent === 'Select visible')
            .emit('click');
        const pending = deferred();
        context.McConnectionData.listDeItems = () => pending.promise;
        const loading = loadList();
        if (outcome === 'disposed') {
            selector.dispose();
        } else if (outcome === 'context') {
            bu = 'Org/B';
        }
        pending.resolve(
            outcome === 'failed'
                ? { ok: false, error: 'offline' }
                : { ok: true, items: outcome === 'empty' ? [] : [{ name: 'A', key: 'A' }] },
        );
        await loading;
        assert.throws(() => selector.getKeys(), /current project|Select at least/);
        assert.equal(all().filter((node) => node.className === 'de-check').length, 0);
        selector.dispose();
    });
}

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
    context.setTimeout = setTimeout;
    context.clearTimeout = clearTimeout;
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
        context.mcdata.JOB_KIND = {
            IMPORT: 'import',
            EXPORT: 'export',
            EXPORT_MULTI_BU: 'exportMultiBu',
            IMPORT_CROSS_BU: 'importCrossBu',
        };
        context.mcdata.getSettings = async () => ({
            transferDefaults: {
                format: 'json',
                git: true,
                mode: 'insert',
                backupBeforeImport: false,
                skipEmptyLines: true,
                debug: true,
            },
        });
        context.McFileSize = { buildLargeFileWarning: () => '' };
        context.JobRunner = class {
            static subscribeActive(listener) {
                listener();
            }
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
        await context.McScreens[screen].activate();
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
        assert.equal(jobs[0].debug, true);
        if (screen === 'export') {
            assert.equal(jobs[0].format, 'json');
            assert.equal(jobs[0].git, true);
        } else {
            assert.equal(jobs[0].mode, 'insert');
            assert.equal(jobs[0].backupBeforeImport, false);
            assert.equal(jobs[0].skipEmptyLines, true);
            assert.equal(jobs[0].clearBeforeImport, false);
        }
        const debugLabel = nodes.find(
            (node) =>
                node.tag === 'label' &&
                node.children.some(
                    (child) => child.textContent === 'Debug logs (may contain sensitive API data)',
                ),
        );
        const debugInput = debugLabel.firstElementChild;
        debugInput.checked = false;
        await debugInput.emit('change');
        const stale = deferred();
        context.mcdata.getSettings = () => stale.promise;
        const activation = context.McScreens[screen].activate();
        debugInput.checked = true;
        await debugInput.emit('change');
        stale.resolve({ transferDefaults: { debug: false } });
        await activation;
        assert.equal(debugInput.checked, true);
        debugInput.checked = false;
        await debugInput.emit('change');
        await runButton.emit('click');
        assert.equal(jobs.at(-1).debug, false);

        const multiPicker = nodes.find((node) => node.className === 'bu-checklist');
        const boxes = descendants(multiPicker).filter((node) => node.type === 'checkbox');
        boxes[1].checked = true;
        await boxes[1].emit('change');
        const manual = nodes.find(
            (node) => node.tag === 'textarea' && node.placeholder === 'MyOrg/BU-A\nOtherOrg/BU-B',
        );
        manual.value = 'Other/Target, Org/B';
        await manual.emit('input');
        if (screen === 'export') {
            const multiLabel = nodes.find(
                (node) =>
                    node.tag === 'label' &&
                    node.children.some(
                        (child) =>
                            child.textContent === 'Export from multiple Business Units (multi-BU)',
                    ),
            );
            multiLabel.firstElementChild.checked = true;
            await multiLabel.firstElementChild.emit('change');
            assert.ok(
                nodes.some((node) =>
                    /DE list source: Org\/B.*Other source BUs have not been validated/.test(
                        node.textContent,
                    ),
                ),
            );
        } else {
            const mode = nodes.find((node) => node.tag === 'select');
            mode.value = 'crossApi';
            await mode.emit('change');
        }
        await loadButton.emit('click');
        checklist.firstElementChild.firstElementChild.checked = true;
        await runButton.emit('click');
        assert.deepEqual(
            [...jobs.at(-1)[screen === 'export' ? 'sources' : 'to']],
            ['Org/B', 'Other/Target'],
        );
        if (screen === 'export') {
            boxes[0].checked = true;
            await boxes[0].emit('change');
            await runButton.emit('click');
            assert.match(messages.at(-1), /current project/);
        }
        context.McState.set({ projectRoot: 'F:/changed' });
        assert.equal(manual.value, '');
        const before = jobs.length;
        await runButton.emit('click');
        assert.equal(jobs.length, before);
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

test('telemetry save failures show session-only state and offer a truthful retry', async () => {
    const { context, nodes, element, load } = setup();
    let isSaved = false;
    context.mcdata.setTelemetryConsent = async (value) => ({
        consent: value,
        persistence: { saved: isSaved },
    });
    load('screens/settings.js');
    context.McScreens.settings.mount(element('host'));
    const toggle = nodes.find((node) => node.tag === 'input');
    const retry = nodes.find((node) => node.textContent === 'Retry saving telemetry');
    toggle.checked = false;
    await toggle.emit('change');
    const status = nodes.find((node) =>
        /disabled this session; choice not saved/.test(node.textContent),
    );
    assert.equal(toggle.checked, false);
    assert.match(status.textContent, /disabled this session; choice not saved/);
    assert.equal(retry.hidden, false);
    isSaved = true;
    await retry.emit('click');
    assert.match(status.textContent, /saved for next launch/);
    assert.equal(retry.hidden, true);
    context.mcdata.setTelemetryConsent = async () => {
        throw new Error('IPC failed');
    };
    await toggle.emit('change');
    assert.match(status.textContent, /Could not confirm/);
    assert.equal(retry.hidden, false);
});

test('transfer settings expose safe controls, truthful failures and retry without destructive values', async () => {
    const { context, nodes, element, load } = setup();
    let isSaved = false;
    const requests = [];
    context.mcdata.getSettings = async () => ({
        consent: false,
        transferDefaults: {
            format: 'tsv',
            mode: 'insert',
            git: true,
            backupBeforeImport: false,
            skipEmptyLines: true,
            debug: true,
        },
        persistence: { saved: true },
    });
    context.mcdata.setTransferDefaults = async (value) => {
        requests.push(value);
        return { transferDefaults: value, persistence: { saved: isSaved } };
    };
    load('screens/settings.js');
    context.McScreens.settings.mount(element('host'));
    await context.McScreens.settings.activate();
    const selects = nodes.filter((node) => node.tag === 'select');
    assert.equal(selects[0].value, 'tsv');
    assert.equal(selects[1].value, 'insert');
    const save = nodes.find((node) => node.textContent === 'Save transfer defaults');
    await save.emit('click');
    assert.deepEqual(structuredClone(requests[0]), {
        format: 'tsv',
        mode: 'insert',
        git: true,
        backupBeforeImport: false,
        skipEmptyLines: true,
        debug: true,
    });
    assert.ok(
        nodes.some((node) => /Transfer defaults apply this session only/.test(node.textContent)),
    );
    assert.equal(save.textContent, 'Retry saving transfer defaults');
    isSaved = true;
    await save.emit('click');
    assert.ok(
        nodes.some((node) => node.textContent === 'Transfer defaults saved for next launch.'),
    );
    context.mcdata.setTransferDefaults = async () => {
        throw new Error('IPC failure');
    };
    await save.emit('click');
    assert.ok(nodes.some((node) => /Could not confirm transfer defaults/.test(node.textContent)));
    assert.ok(
        nodes.some((node) => /Debug logs may contain sensitive API data/.test(node.textContent)),
    );
});

test('project save failure retains the selected session project and retries explicitly', async () => {
    const { context, nodes, element, load } = setup();
    context.JobRunner = class {
        static subscribeActive(listener) {
            listener();
        }
        element = element('runner');
    };
    context.mcdata.loadConfig = async () => ({ configured: false });
    let isSaved = false;
    context.mcdata.setProjectRoot = async () => ({ persistence: { saved: isSaved } });
    load('screens/connections.js');
    const host = element('host');
    context.McScreens.connections.mount(host);
    const use = nodes.find((node) => node.textContent === 'Use this folder');
    await use.emit('click');
    assert.equal(context.McState.get().projectRoot, 'F:/A');
    assert.ok(nodes.some((node) => /session only; not saved/.test(node.textContent)));
    isSaved = true;
    await use.emit('click');
    assert.ok(nodes.some((node) => node.textContent === 'Project folder saved for next launch.'));
});

test('file picker lists every selected path and replaces only after a new selection', async () => {
    const { context, element, load } = setup();
    context.McFileSize = require('../src/shared/file-size');
    let chosen = [
        { path: 'F:/first/shared.csv', size: 10 },
        { path: 'F:/second/shared.csv', size: 20 },
    ];
    context.mcdata.chooseFiles = async () => chosen;
    load('forms.js');
    const picker = context.McForms.filePicker();
    const host = element('host');
    host.append(picker.wrap);
    const browse = descendants(host).find((node) => node.tag === 'button');
    const paths = () => descendants(host).filter((node) => node.tag === 'li');
    assert.equal(paths().length, 0);
    await browse.emit('click');
    assert.match(descendants(host).find((node) => node.tag === 'input').value, /2 files selected/);
    assert.deepEqual(
        paths().map((node) => node.textContent),
        ['F:/first/shared.csv (10 B)', 'F:/second/shared.csv (20 B)'],
    );
    assert.deepEqual(
        [...picker.getFiles()],
        chosen.map((file) => file.path),
    );
    chosen = [];
    await browse.emit('click');
    assert.equal(paths().length, 2);
    chosen = [{ path: 'F:/replacement.csv', size: 30 }];
    await browse.emit('click');
    assert.equal(paths().length, 1);
    assert.match(paths()[0].textContent, /replacement.csv/);
    assert.deepEqual([...picker.getFiles()], ['F:/replacement.csv']);
});

test('remove and clear files update summary and preserve frozen submitted paths', async () => {
    const { context, load } = setup();
    context.McFileSize = require('../src/shared/file-size');
    context.mcdata.chooseFiles = async () => [
        { path: 'F:/large.csv', size: 4 * 1024 ** 3 },
        { path: 'F:/small.csv', size: 10 },
    ];
    load('forms.js');
    const picker = context.McForms.filePicker();
    const all = () => descendants(picker.wrap);
    const action = (label) => all().find((node) => node.attributes['aria-label'] === label);
    const clear = all().find((node) => node.textContent === 'Clear files');
    const note = all().find((node) => node.className === 'field-hint muted');
    assert.equal(clear.disabled, true);
    await action('Browse for import files').emit('click');
    const submitted = Object.freeze({ filePaths: Object.freeze([...picker.getFiles()]) });
    assert.match(note.textContent, /Large import/);
    await action('Remove F:/large.csv').emit('click');
    assert.deepEqual([...picker.getFiles()], ['F:/small.csv']);
    assert.equal(picker.getSizedFiles()[0].size, 10);
    assert.match(all().find((node) => node.tag === 'input').value, /small.csv/);
    assert.equal(note.textContent, '');
    assert.equal(clear.disabled, false);
    await clear.emit('click');
    assert.deepEqual([...picker.getFiles()], []);
    assert.deepEqual([...picker.getSizedFiles()], []);
    assert.equal(all().filter((node) => node.tag === 'li').length, 0);
    assert.equal(all().find((node) => node.tag === 'input').value, '');
    assert.equal(clear.disabled, true);
    assert.deepEqual([...submitted.filePaths], ['F:/large.csv', 'F:/small.csv']);
});

test('export uses the global project and validates optional row limits inline', async () => {
    const { context, nodes, element, load } = setup();
    const jobs = [];
    const messages = [];
    let selectorOptions;
    context.McUI.toast = (message) => {
        messages.push(message);
    };
    context.McBuPicker = class {
        element = element('bu');
        onChange() {}
        getValue() {
            return 'Org/BU';
        }
        getValues() {
            return ['Org/BU'];
        }
    };
    context.McDeSelector = class {
        element = element('de');
        constructor(options) {
            selectorOptions = options;
        }
        invalidate() {}
        getKeys() {
            return ['KEY'];
        }
    };
    context.JobRunner = class {
        static subscribeActive(listener) {
            listener();
        }
        element = element('runner');
        async start(job) {
            jobs.push(job);
        }
    };
    load('forms.js');
    load('screens/export.js');
    context.McScreens.export.mount(element('host'));
    assert.equal(
        nodes.some((node) => node.textContent === 'Browse…'),
        false,
    );
    const info = nodes.find((node) => /Export project:/.test(node.textContent));
    assert.match(info.textContent, /F:\/A/);
    assert.equal(selectorOptions.getProjectRoot(), 'F:/A');
    const limit = nodes.find((node) => node.type === 'number');
    const error = nodes.find((node) => node.id === 'export-max-rows-error');
    const run = nodes.find((node) => node.textContent === 'Start export');
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
        limit.value = value;
        await limit.emit('input');
        assert.match(error.textContent, /positive whole number/);
        assert.equal(limit.attributes['aria-invalid'], 'true');
        await run.emit('click');
        assert.equal(jobs.length, 0);
        assert.equal(limit.focused, true);
    }
    limit.value = '';
    limit.validity = { badInput: true };
    await run.emit('click');
    assert.equal(jobs.length, 0);
    limit.validity.badInput = false;
    for (const value of ['', ' '.repeat(3), '10']) {
        limit.value = value;
        await limit.emit('input');
        assert.equal(error.textContent, '');
        await run.emit('click');
        assert.equal(jobs.at(-1).projectRoot, 'F:/A');
        assert.equal(jobs.at(-1).maxRowsPerFile, value.trim() ? 10 : undefined);
    }
    context.McState.set({ projectRoot: 'F:/B' });
    assert.match(info.textContent, /F:\/B/);
    assert.equal(selectorOptions.getProjectRoot(), 'F:/B');
    await run.emit('click');
    assert.equal(jobs.at(-1).projectRoot, 'F:/B');
    context.McState.set({ projectRoot: '' });
    const count = jobs.length;
    await run.emit('click');
    assert.equal(jobs.length, count);
    assert.match(messages.at(-1), /Choose a project/);
    assert.match(info.textContent, /No project selected/);
});

test('global active job returns to its cached screen, focuses the runner and survives cancellation', async () => {
    const { context, element, load } = setup();
    context.setTimeout = setTimeout;
    context.clearTimeout = clearTimeout;
    const events = new Map();
    for (const name of ['onJobLog', 'onJobProgress', 'onJobComplete', 'onJobError']) {
        events.set(name, new Set());
        context.mcdata[name] = (handler) => {
            events.get(name).add(handler);
            return () => events.get(name).delete(handler);
        };
    }
    const starting = deferred();
    context.mcdata.startJob = () => starting.promise;
    context.mcdata.cancelJob = async () => false;
    const view = element('main');
    const banner = element('section');
    const status = element('span');
    const back = element('button');
    const tabs = ['connections', 'export', 'import', 'settings'].map((name) => {
        const tab = element('button');
        tab.dataset.view = name;
        return tab;
    });
    let ready;
    let runner;
    let mounts = 0;
    context.document = {
        querySelector: (selector) =>
            ({
                '#view': view,
                '#active-job': banner,
                '#active-job-status': status,
                '#active-job-return': back,
                '.tab.active': tabs[2],
            })[selector],
        querySelectorAll: () => tabs,
        createElement: element,
    };
    context.addEventListener = (_event, handler) => {
        ready = handler;
    };
    context.mcdata.getAppInfo = async () => ({});
    context.McUpdates = { init() {} };
    context.McSettings = { initConsentGate() {} };
    context.McScreens = Object.fromEntries(tabs.map((tab) => [tab.dataset.view, { mount() {} }]));
    context.McScreens.import.mount = (host) => {
        mounts++;
        runner = new context.JobRunner({ view: 'import', label: 'Import' });
        host.append(runner.element);
    };
    load('job-runner.js');
    load('renderer.js');
    await ready();
    assert.equal(banner.hidden, true);
    await tabs[2].emit('click');
    const original = runner;
    const finished = runner.start({ kind: 'import' });
    assert.match(status.textContent, /Import: Starting/);
    starting.resolve({ jobId: 'active' });
    await new Promise(setImmediate);
    for (const tab of tabs) {
        await tab.emit('click');
        assert.equal(banner.hidden, false);
        assert.match(status.textContent, /Import: Running/);
    }
    for (const handler of events.get('onJobProgress')) {
        handler({ jobId: 'other', event: { phase: 'imported', records: 99 } });
        handler({ jobId: 'active', event: { phase: 'imported', records: 12 } });
    }
    assert.match(status.textContent, /Imported 12 rows/);
    assert.match(back.textContent, /Return to import job/);
    await back.emit('click');
    assert.equal(mounts, 1);
    assert.equal(runner, original);
    assert.equal(runner.element.focused, true);
    assert.equal(tabs[2].attributes['aria-current'], 'page');
    assert.equal(view.children.filter((node) => !node.hidden).length, 1);
    await runner.cancel();
    assert.equal(banner.hidden, false);
    assert.match(status.textContent, /Could not stop worker/);
    context.document.activeElement = back;
    for (const handler of events.get('onJobComplete')) {
        handler({ jobId: 'active', cancelled: true });
    }
    const result = await finished;
    assert.equal(result.cancelled, true);
    assert.equal(banner.hidden, true);
    assert.equal(tabs[2].focused, true);
    for (const handlers of events.values()) {
        assert.equal(handlers.size, 0);
    }
});

test('all cached screen starts follow active jobs throughout navigation', async () => {
    const { context, nodes, element, load } = setup();
    context.setTimeout = setTimeout;
    context.clearTimeout = clearTimeout;
    const events = new Map();
    for (const name of ['onJobLog', 'onJobProgress', 'onJobComplete', 'onJobError']) {
        events.set(name, new Set());
        context.mcdata[name] = (handler) => {
            events.get(name).add(handler);
            return () => events.get(name).delete(handler);
        };
    }
    context.mcdata.loadConfig = async () => ({ configured: false });
    context.McFileSize = require('../src/shared/file-size');
    context.McBuPicker = class {
        element = element('picker');
        onChange() {}
        refresh() {}
        getValue() {
            return 'Org/BU';
        }
        getValues() {
            return ['Org/BU'];
        }
    };
    context.McDeSelector = class {
        element = element('selector');
        invalidate() {}
    };
    const view = element('main');
    const tabs = ['connections', 'export', 'import'].map((name) => {
        const tab = element('button');
        tab.dataset.view = name;
        return tab;
    });
    context.document = {
        querySelector: (selector) => (selector === '#view' ? view : undefined),
        querySelectorAll: () => tabs,
        createElement: element,
    };
    let ready;
    context.addEventListener = (_event, handler) => {
        ready = handler;
    };
    context.mcdata.getAppInfo = async () => ({});
    context.McUpdates = { init() {} };
    context.McSettings = { initConsentGate() {} };
    load('forms.js');
    load('job-runner.js');
    for (const screen of ['connections', 'export', 'import']) {
        load(`screens/${screen}.js`);
    }
    load('renderer.js');
    await ready();
    const runner = new context.JobRunner();
    const start = deferred();
    context.mcdata.startJob = () => start.promise;
    context.mcdata.cancelJob = async () => true;
    const finished = runner.start({});
    const buttons = () =>
        nodes.filter((node) =>
            ['Start export', 'Start import', 'Fetch business units & save'].includes(
                node.textContent,
            ),
        );
    for (const tab of tabs) {
        await tab.emit('click');
        assert.ok(buttons().every((button) => button.disabled));
    }
    assert.equal(buttons().length, 3);
    start.resolve({ jobId: 'active' });
    await new Promise(setImmediate);
    assert.ok(buttons().every((button) => button.disabled));
    await runner.cancel();
    for (const tab of tabs) {
        await tab.emit('click');
        assert.ok(buttons().every((button) => button.disabled));
    }
    for (const handler of events.get('onJobComplete')) {
        handler({ jobId: 'active', cancelled: true });
    }
    await finished;
    assert.ok(buttons().every((button) => !button.disabled));
    assert.equal(buttons().length, 3);
});

test('picker controls have accessible names without changing their public APIs', () => {
    const { context, load } = setup();
    load('forms.js');
    const folder = context.McForms.directoryPicker();
    assert.equal(folder.input.attributes['aria-label'], 'Selected folder');
    const files = context.McForms.filePicker();
    assert.equal(
        Object.keys(files)
            .toSorted((a, b) => a.localeCompare(b))
            .join(','),
        'getFiles,getSizedFiles,wrap',
    );
    const nodes = descendants(files.wrap);
    assert.equal(
        nodes.find((node) => node.tag === 'input').attributes['aria-label'],
        'Selected import files',
    );
    assert.equal(
        nodes.find((node) => node.tag === 'button').attributes['aria-label'],
        'Browse for import files',
    );
});

test('cached connections refresh on activation and ignore previous project results', async () => {
    const { context, nodes, element, load } = setup();
    context.JobRunner = class {
        static subscribeActive(listener) {
            listener();
        }
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
