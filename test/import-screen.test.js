'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JOB_KIND } = require('../src/shared/channels');
const { buildMcdataArgv } = require('../src/shared/build-argv');
const fileSize = require('../src/shared/file-size');

function mountAdvisoryScreen({ alertResult, cancelAtStart = false } = {}) {
    const nodes = [];
    const jobs = [];
    const alerts = [];
    const toasts = [];
    let activeListener;
    let runButton;
    let reentrantClick;
    const element = (tag, options = {}) => {
        const node = {
            tag,
            ...options,
            style: {},
            value: '',
            listeners: {},
            append() {},
            setAttribute() {},
            removeAttribute() {},
            remove() {},
            focus() {},
            showModal() {},
            close() {
                node.listeners.close();
            },
            addEventListener(event, callback) {
                node.listeners[event] = callback;
            },
        };
        nodes.push(node);
        return node;
    };
    const context = vm.createContext({
        document: { body: element('body') },
        McUI: {
            element,
            toast: (message) => {
                toasts.push(message);
            },
        },
        McForms: {
            field: () => element('field'),
            select: (_options, value) => Object.assign(element('select'), { value }),
            checkbox: (label, checked) => ({
                input: Object.assign(element('input', { label }), { checked }),
                wrap: element('checkbox'),
            }),
            button: (text) => {
                const node = element('button', { text });
                if (text === 'Start import') {
                    runButton = node;
                }
                return node;
            },
            filePicker: () => ({
                wrap: element('files'),
                getFiles: () => ['large.csv'],
                getSizedFiles: () => [{ path: 'large.csv', size: fileSize.LARGE_FILE_WARN_BYTES }],
            }),
        },
        McBuPicker: class {
            element = element('picker');
            onChange() {}
            getValue() {
                return 'Org/BU';
            }
            getValues() {
                return ['Org/Target'];
            }
        },
        McDeSelector: class {
            element = element('de');
            invalidate() {}
            getKeys() {
                return ['DE'];
            }
        },
        JobRunner: class {
            static subscribeActive(listener) {
                activeListener = listener;
                listener();
            }
            element = element('runner');
            async start(job) {
                if (cancelAtStart) {
                    return { ok: false, cancelled: true };
                }
                jobs.push(job);
                return { ok: true };
            }
        },
        McState: { get: () => ({}) },
        McFileSize: fileSize,
        mcdata: { JOB_KIND },
        confirm: () => assert.fail('Size advisory must not request a decision'),
        alert: (message) => {
            alerts.push(message);
            reentrantClick = runButton.listeners.click();
            return alertResult;
        },
    });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../src/renderer/screens/import.js'), 'utf8'),
        context,
    );
    context.McScreens.import.mount(element('container'));
    const mode = nodes.find((node) => node.tag === 'select');
    mode.value = 'singleFile';
    mode.listeners.change();
    return {
        nodes,
        jobs,
        alerts,
        toasts,
        mode,
        click: async () => {
            await runButton.listeners.click();
            await reentrantClick;
        },
        setActive: (active) => activeListener(active),
    };
}

for (const [dismissal, alertResult] of [
    ['acknowledged', undefined],
    ['dismissed without a decision', false],
]) {
    test(`large-file advisory ${dismissal} still starts exactly one import`, async () => {
        const screen = mountAdvisoryScreen({ alertResult });
        await screen.click();
        assert.equal(screen.alerts.length, 1);
        assert.equal(
            screen.alerts[0],
            'You are about to import 1 file(s) totalling 1.00 GB (largest 1.00 GB).\n\n' +
                'Large imports can take a long time. ' +
                'Keep this app open and stay connected until the job finishes.',
        );
        assert.doesNotMatch(screen.alerts[0], /Continue\?/);
        assert.equal(screen.jobs.length, 1);
        assert.ok(Object.isFrozen(screen.jobs[0]));
        assert.ok(Object.isFrozen(screen.jobs[0].filePaths));
        assert.deepEqual(screen.toasts, []);
        screen.setActive(true);
        await screen.click();
        assert.equal(screen.jobs.length, 1);
        assert.equal(screen.alerts.length, 1);
    });
}

test('large-file advisory does not override independent job cancellation', async () => {
    const screen = mountAdvisoryScreen({ cancelAtStart: true });
    await screen.click();
    assert.equal(screen.alerts.length, 1);
    assert.equal(screen.jobs.length, 0);
});

test('file advisory remains separate from destructive confirmation cancellation', async () => {
    const screen = mountAdvisoryScreen();
    await screen.click();
    assert.equal(screen.jobs.length, 1);
    screen.nodes.find(
        (node) => node.label === 'Clear all rows before import (destructive)',
    ).checked = true;
    const pending = screen.click();
    const answer = screen.nodes.find((node) => node.attrs?.id === 'clear-answer');
    const authorize = screen.nodes.find((node) => node.text === 'Clear and import');
    assert.equal(authorize.disabled, true);
    answer.value = 'clear';
    answer.listeners.input();
    assert.equal(authorize.disabled, true);
    answer.value = 'CLEAR';
    answer.listeners.input();
    assert.equal(authorize.disabled, false);
    const dialog = screen.nodes.find((node) => node.tag === 'dialog');
    dialog.listeners.cancel();
    dialog.close();
    await pending;
    assert.equal(screen.jobs.length, 1);
    assert.equal(screen.alerts.length, 1);
    assert.deepEqual(screen.toasts, [
        'Clear-before-import cancelled — confirmation did not match.',
    ]);
});

test('imports without file paths do not show the size advisory', async () => {
    const screen = mountAdvisoryScreen();
    for (const mode of ['singleDe', 'crossApi']) {
        screen.mode.value = mode;
        screen.mode.listeners.change();
        await screen.click();
    }
    assert.equal(screen.jobs.length, 2);
    assert.equal(screen.alerts.length, 0);
});

test('import checkbox defaults off and routes checked state across import modes', async () => {
    const selects = [];
    const checks = [];
    const jobs = [];
    const nodes = [];
    let runButton;
    const element = (tag) => {
        const node = {
            tag,
            style: {},
            value: '',
            listeners: {},
            append() {},
            setAttribute() {},
            removeAttribute() {},
            addEventListener(event, callback) {
                node.listeners[event] = callback;
            },
        };
        nodes.push(node);
        return node;
    };
    const context = vm.createContext({
        McUI: { element, toast: (message) => assert.fail(message) },
        McForms: {
            field: () => element('field'),
            select: (_options, value) => {
                const node = element('select');
                node.value = value;
                selects.push(node);
                return node;
            },
            checkbox: (label, checked) => {
                const input = element('input');
                input.checked = checked;
                const check = { label, input, wrap: element('checkbox') };
                checks.push(check);
                return check;
            },
            button: () => {
                runButton = element('button');
                return runButton;
            },
            filePicker: () => ({
                wrap: element('files'),
                getFiles: () => ['data.csv'],
                getSizedFiles: () => [],
            }),
        },
        McBuPicker: class {
            element = element('picker');
            onChange() {}
            getValue() {
                return 'Org/BU';
            }
            getValues() {
                return ['Org/Target'];
            }
        },
        McDeSelector: class {
            element = element('de');
            invalidate() {}
            getKeys() {
                return ['DE'];
            }
        },
        JobRunner: class {
            static subscribeActive(listener) {
                listener();
            }
            element = element('runner');
            async start(job) {
                jobs.push(job);
            }
        },
        McState: { get: () => ({}) },
        McFileSize: { buildLargeFileWarning: () => '' },
        mcdata: { JOB_KIND },
    });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../src/renderer/screens/import.js'), 'utf8'),
        context,
    );
    context.McScreens.import.mount(element('container'));
    const checkbox = checks.find((check) => check.label === 'Skip empty lines (CSV/TSV)');
    assert.ok(checkbox);
    assert.equal(checkbox.input.checked, false);
    await runButton.listeners.click();
    assert.equal(jobs.at(-1).skipEmptyLines, false);
    assert.equal(buildMcdataArgv(jobs.at(-1)).includes('--skip-empty-lines'), false);
    checkbox.input.checked = true;
    for (const mode of ['singleDe', 'singleFile', 'crossFile', 'crossApi', 'singleDe']) {
        selects[0].value = mode;
        selects[0].listeners.change();
        await runButton.listeners.click();
        const isExpected = mode !== 'crossApi';
        assert.equal(jobs.at(-1).skipEmptyLines, isExpected);
        assert.equal(buildMcdataArgv(jobs.at(-1)).includes('--skip-empty-lines'), isExpected);
        assert.equal(checkbox.wrap.style.display, isExpected ? '' : 'none');
    }
});
