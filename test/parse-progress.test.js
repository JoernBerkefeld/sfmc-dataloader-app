'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProgressLine } = require('../src/shared/parse-progress');

test('parses paged download batch with ratio', () => {
    const event = parseProgressLine(
        '17:04:12 info: Downloading batch 3 of 10 (7500 records so far)',
    );
    assert.deepEqual(event, {
        phase: 'download',
        current: 3,
        total: 10,
        records: 7500,
        ratio: 0.3,
    });
});

test('parses unpaged download batch (no total)', () => {
    const event = parseProgressLine(
        '17:04:12 info: Downloading next batch (currently 2500 records)',
    );
    assert.deepEqual(event, { phase: 'download', records: 2500 });
});

test('parses upload batch with ratio', () => {
    const event = parseProgressLine('17:04:12 info: Uploading batch 2 of 4');
    assert.deepEqual(event, { phase: 'upload', current: 2, total: 4, ratio: 0.5 });
});

test('parses exported and imported row counts', () => {
    assert.deepEqual(parseProgressLine('17:04:12 info: Exported: "/data/DE.csv" (1234 rows)'), {
        phase: 'exported',
        records: 1234,
    });
    assert.deepEqual(
        parseProgressLine('17:04:12 info: Imported: "/data/DE.csv" (999 rows) -> DE DE_A'),
        { phase: 'imported', records: 999 },
    );
});

test('parses row count before/after import', () => {
    assert.deepEqual(parseProgressLine('17:04:12 info: Row count before import: 50 (DE "DE_A")'), {
        phase: 'rowCount',
        when: 'before',
        records: 50,
    });
    assert.deepEqual(parseProgressLine('17:04:12 info: Row count after import: 1284 (DE "DE_A")'), {
        phase: 'rowCount',
        when: 'after',
        records: 1284,
    });
});

test('works without a timestamp/level prefix', () => {
    assert.deepEqual(parseProgressLine('Uploading batch 1 of 1'), {
        phase: 'upload',
        current: 1,
        total: 1,
        ratio: 1,
    });
});

test('returns undefined for non-progress lines and empty input', () => {
    assert.equal(parseProgressLine('17:04:12 info: Debug log: "/logs/data/x.log"'), undefined);
    assert.equal(parseProgressLine(''), undefined);
    assert.equal(parseProgressLine(), undefined);
});
