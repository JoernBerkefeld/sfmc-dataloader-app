'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHANNELS, JOB_KIND } = require('../src/shared/channels');

test('CHANNELS exposes unique, non-empty channel names', () => {
    const values = Object.values(CHANNELS);
    assert.ok(values.length > 0, 'expected at least one channel');
    for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.ok(value.length > 0, 'channel name must be non-empty');
    }
    assert.equal(new Set(values).size, values.length, 'channel names must be unique');
});

test('JOB_KIND covers the full-parity operation set', () => {
    assert.deepEqual(
        Object.keys(JOB_KIND).toSorted((a, b) => a.localeCompare(b)),
        ['EXPORT', 'EXPORT_MULTI_BU', 'IMPORT', 'IMPORT_CROSS_BU', 'INIT'],
    );
});

test('sfmc-dataloader public API exports the entry points the app relies on', async () => {
    const dl = await import('sfmc-dataloader');
    for (const name of [
        'main',
        'fetchDeList',
        'loadProjectConfig',
        'multiBuExport',
        'crossBuImport',
        'getDeRowCount',
        'resolveImportRoute',
    ]) {
        assert.equal(
            typeof dl[name],
            'function',
            `expected sfmc-dataloader.${name} to be a function`,
        );
    }
});
