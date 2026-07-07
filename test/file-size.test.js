'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    LARGE_FILE_WARN_BYTES,
    formatBytes,
    summarizeFiles,
    buildLargeFileWarning,
} = require('../src/shared/file-size');

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

test('formatBytes renders binary units with sensible precision', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(KB), '1.00 KB');
    assert.equal(formatBytes(1.5 * MB), '1.50 MB');
    assert.equal(formatBytes(2.75 * GB), '2.75 GB');
    assert.equal(formatBytes(15 * MB), '15.0 MB');
    assert.equal(formatBytes(150 * MB), '150 MB');
});

test('formatBytes is defensive against bad input', () => {
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes('nope'), '0 B');
    assert.equal(formatBytes(Infinity), '0 B');
});

test('summarizeFiles totals sizes and flags large files', () => {
    const summary = summarizeFiles([
        { path: 'a.csv', size: 100 * MB },
        { path: 'b.csv', size: 2 * GB },
        { path: 'c.csv', size: 0 },
    ]);
    assert.equal(summary.count, 3);
    assert.equal(summary.totalBytes, 100 * MB + 2 * GB);
    assert.equal(summary.largestBytes, 2 * GB);
    assert.equal(summary.hasLargeFile, true);
    assert.equal(summary.largeFiles.length, 1);
    assert.equal(summary.largeFiles[0].path, 'b.csv');
});

test('summarizeFiles treats a file exactly at the threshold as large', () => {
    const summary = summarizeFiles([{ path: 'edge.csv', size: LARGE_FILE_WARN_BYTES }]);
    assert.equal(summary.hasLargeFile, true);
});

test('summarizeFiles ignores unknown/negative sizes and handles empty input', () => {
    const summary = summarizeFiles([{ path: 'x.csv', size: -5 }, { path: 'y.csv' }]);
    assert.equal(summary.totalBytes, 0);
    assert.equal(summary.hasLargeFile, false);

    const empty = summarizeFiles([]);
    assert.equal(empty.count, 0);
    assert.equal(empty.totalText, '0 B');

    const bogus = summarizeFiles(null);
    assert.equal(bogus.count, 0);
});

test('buildLargeFileWarning only warns when a file crosses the threshold', () => {
    assert.equal(buildLargeFileWarning([{ path: 'small.csv', size: 10 * MB }]), '');

    const message = buildLargeFileWarning([
        { path: 'big.csv', size: 3 * GB },
        { path: 'small.csv', size: 5 * MB },
    ]);
    assert.match(message, /import 2 file\(s\)/);
    assert.match(message, /largest 3\.00 GB/);
    assert.match(message, /Continue\?/);
});
