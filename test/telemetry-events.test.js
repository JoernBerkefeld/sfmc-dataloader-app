'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const events = require('../src/shared/telemetry-events');

test('EVENTS has no uninstall event (churn inferred from missing launches)', () => {
    assert.equal(events.EVENTS.APP_UNINSTALL, undefined);
    assert.equal(events.EVENTS.APP_INSTALL, 'app_install');
    assert.equal(events.EVENTS.APP_UPDATE, 'app_update');
    assert.equal(events.EVENTS.APP_LAUNCH, 'app_launch');
});

test('normalizeLocale keeps only the lowercase primary subtag', () => {
    assert.equal(events.normalizeLocale('en-US'), 'en');
    assert.equal(events.normalizeLocale('pt_BR'), 'pt');
    assert.equal(events.normalizeLocale('DE'), 'de');
    assert.equal(events.normalizeLocale('ceb'), 'ceb');
});

test('normalizeLocale collapses unusable input to "unknown"', () => {
    assert.equal(events.normalizeLocale(''), 'unknown');
    assert.equal(events.normalizeLocale(), 'unknown');
    assert.equal(events.normalizeLocale(42), 'unknown');
    assert.equal(events.normalizeLocale('x'), 'unknown');
    assert.equal(events.normalizeLocale('123'), 'unknown');
});

test('normalizeFormat only allows csv/tsv/json, else "other"', () => {
    assert.equal(events.normalizeFormat('csv'), 'csv');
    assert.equal(events.normalizeFormat('tsv'), 'tsv');
    assert.equal(events.normalizeFormat('json'), 'json');
    assert.equal(events.normalizeFormat('xlsx'), 'other');
    assert.equal(events.normalizeFormat(), 'other');
});

test('normalizeResult only allows success/error/cancelled, else "unknown"', () => {
    assert.equal(events.normalizeResult('success'), 'success');
    assert.equal(events.normalizeResult('error'), 'error');
    assert.equal(events.normalizeResult('cancelled'), 'cancelled');
    assert.equal(events.normalizeResult('boom'), 'unknown');
    assert.equal(events.normalizeResult(), 'unknown');
});

test('normalizeKind maps worker JOB_KIND values to the coarse enum', () => {
    assert.equal(events.normalizeKind('export'), 'export');
    assert.equal(events.normalizeKind('exportMultiBu'), 'export_multi_bu');
    assert.equal(events.normalizeKind('import'), 'import');
    assert.equal(events.normalizeKind('importCrossBu'), 'import_cross_bu');
    assert.equal(events.normalizeKind('init'), 'init');
    assert.equal(events.normalizeKind('nonsense'), 'unknown');
});

test('installChannel prefers packaging markers over the platform default', () => {
    assert.equal(events.installChannel({ windowsStore: true, platform: 'win32' }), 'windows_store');
    assert.equal(
        events.installChannel({ platform: 'linux', env: { APPIMAGE: '/tmp/app.AppImage' } }),
        'appimage',
    );
    assert.equal(events.installChannel({ platform: 'linux', env: { SNAP: '/snap/x' } }), 'snap');
    assert.equal(
        events.installChannel({ platform: 'linux', env: { FLATPAK_ID: 'com.x' } }),
        'flatpak',
    );
});

test('installChannel falls back to the platform installer', () => {
    assert.equal(events.installChannel({ platform: 'win32', env: {} }), 'nsis');
    assert.equal(events.installChannel({ platform: 'darwin', env: {} }), 'dmg');
    assert.equal(events.installChannel({ platform: 'linux', env: {} }), 'linux_other');
    assert.equal(events.installChannel({ platform: 'sunos', env: {} }), 'unknown');
    assert.equal(events.installChannel(), 'unknown');
});

test('sizeBucket collapses byte counts into coarse ranges', () => {
    assert.equal(events.sizeBucket(0), '0');
    assert.equal(events.sizeBucket(-5), '0');
    assert.equal(events.sizeBucket(500), '<1MB');
    assert.equal(events.sizeBucket(5 * 1024 * 1024), '1-10MB');
    assert.equal(events.sizeBucket(50 * 1024 * 1024), '10-100MB');
    assert.equal(events.sizeBucket(500 * 1024 * 1024), '100MB-1GB');
    assert.equal(events.sizeBucket(5 * 1024 * 1024 * 1024), '1-10GB');
    assert.equal(events.sizeBucket(50 * 1024 * 1024 * 1024), '>10GB');
    assert.equal(events.sizeBucket('nope'), '0');
});

test('rowCountBucket collapses row counts into coarse ranges', () => {
    assert.equal(events.rowCountBucket(0), '0');
    assert.equal(events.rowCountBucket(50), '1-100');
    assert.equal(events.rowCountBucket(100), '1-100');
    assert.equal(events.rowCountBucket(500), '101-1K');
    assert.equal(events.rowCountBucket(5000), '1K-10K');
    assert.equal(events.rowCountBucket(50_000), '10K-100K');
    assert.equal(events.rowCountBucket(500_000), '100K-1M');
    assert.equal(events.rowCountBucket(5_000_000), '>1M');
});

test('deCountBucket collapses DE counts into coarse ranges', () => {
    assert.equal(events.deCountBucket(0), '0');
    assert.equal(events.deCountBucket(1), '1');
    assert.equal(events.deCountBucket(3), '2-5');
    assert.equal(events.deCountBucket(10), '6-20');
    assert.equal(events.deCountBucket(40), '21-50');
    assert.equal(events.deCountBucket(500), '>50');
});

test('sanitizeParams keeps only primitives and caps string length', () => {
    const long = 'a'.repeat(200);
    const out = events.sanitizeParams({
        keep_string: 'ok',
        keep_number: 5,
        keep_bool: true,
        drop_object: { secret: 'x' },
        drop_array: [1, 2],
        // eslint-disable-next-line unicorn/no-null -- deliberately verifying null is dropped by the firewall
        drop_null: null,
        drop_undefined: undefined,
        drop_nan: NaN,
        long_string: long,
    });
    assert.deepEqual(
        Object.keys(out).toSorted((a, b) => a.localeCompare(b)),
        ['keep_bool', 'keep_number', 'keep_string', 'long_string'],
    );
    assert.equal(out.long_string.length, 64);
});

test('sanitizeParams tolerates non-object input', () => {
    // eslint-disable-next-line unicorn/no-null -- callers may pass null; must not throw
    assert.deepEqual(events.sanitizeParams(null), {});
    assert.deepEqual(events.sanitizeParams('str'), {});
    assert.deepEqual(events.sanitizeParams(), {});
});

test('buildLifecycleParams carries platform data but never a locale', () => {
    const parameters = events.buildLifecycleParams({
        appVersion: '1.2.3',
        platform: 'win32',
        osVersion: '10.0.22631',
        arch: 'x64',
        channel: 'nsis',
    });
    assert.equal(parameters.app_version, '1.2.3');
    assert.equal(parameters.os, 'win32');
    assert.equal(parameters.os_version, '10.0.22631');
    assert.equal(parameters.arch, 'x64');
    assert.equal(parameters.install_channel, 'nsis');
    assert.equal(parameters.locale, undefined);
});

test('buildExportParams buckets the DE count and attaches locale', () => {
    const parameters = events.buildExportParams({
        appVersion: '1.2.3',
        format: 'csv',
        deCount: 12,
        multiBu: true,
        locale: 'en-US',
    });
    assert.equal(parameters.format, 'csv');
    assert.equal(parameters.de_count_bucket, '6-20');
    assert.equal(parameters.multi_bu, true);
    assert.equal(parameters.locale, 'en');
});

test('buildImportParams buckets size + counts and defaults mode to upsert', () => {
    const parameters = events.buildImportParams({
        appVersion: '1.2.3',
        format: 'tsv',
        deCount: 2,
        fileCount: 3,
        totalBytes: 50 * 1024 * 1024,
        mode: undefined,
        crossBu: false,
        locale: 'de',
    });
    assert.equal(parameters.format, 'tsv');
    assert.equal(parameters.de_count_bucket, '2-5');
    assert.equal(parameters.file_count_bucket, '2-5');
    assert.equal(parameters.size_bucket, '10-100MB');
    assert.equal(parameters.mode, 'upsert');
    assert.equal(parameters.cross_bu, false);
    assert.equal(parameters.locale, 'de');
});

test('buildImportParams preserves an explicit insert mode', () => {
    const parameters = events.buildImportParams({
        appVersion: '1.2.3',
        format: 'csv',
        deCount: 1,
        mode: 'insert',
    });
    assert.equal(parameters.mode, 'insert');
});

test('buildJobOutcomeParams buckets rows and normalises kind + result', () => {
    const parameters = events.buildJobOutcomeParams({
        appVersion: '1.2.3',
        kind: 'exportMultiBu',
        result: 'success',
        rowCount: 5000,
        locale: 'fr-CA',
    });
    assert.equal(parameters.kind, 'export_multi_bu');
    assert.equal(parameters.result, 'success');
    assert.equal(parameters.row_count_bucket, '1K-10K');
    assert.equal(parameters.locale, 'fr');
});

test('no builder ever emits a value that is not a primitive', () => {
    const builders = [
        events.buildLifecycleParams({ appVersion: '1', platform: 'linux' }),
        events.buildExportParams({ appVersion: '1', format: 'csv', deCount: 1 }),
        events.buildImportParams({ appVersion: '1', format: 'csv', deCount: 1 }),
        events.buildJobOutcomeParams({ appVersion: '1', kind: 'export', result: 'error' }),
    ];
    for (const parameters of builders) {
        for (const value of Object.values(parameters)) {
            assert.ok(
                ['string', 'number', 'boolean'].includes(typeof value),
                `unexpected non-primitive param value: ${typeof value}`,
            );
        }
    }
});
