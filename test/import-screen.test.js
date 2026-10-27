'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JOB_KIND } = require('../src/shared/channels');
const { buildMcdataArgv } = require('../src/shared/build-argv');

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
