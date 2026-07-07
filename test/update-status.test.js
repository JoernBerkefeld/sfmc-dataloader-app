'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    UPDATE_STATUS,
    clampPercent,
    describeUpdateStatus,
} = require('../src/shared/update-status');

test('clampPercent rounds and bounds to [0,100]', () => {
    assert.equal(clampPercent(0), 0);
    assert.equal(clampPercent(42.6), 43);
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent(NaN), 0);
    assert.equal(clampPercent('nope'), 0);
    // Non-finite input is treated as unknown → 0, never NaN in the UI.
    assert.equal(clampPercent(Infinity), 0);
});

test('describeUpdateStatus reports a busy check', () => {
    const view = describeUpdateStatus({ status: UPDATE_STATUS.CHECKING });
    assert.match(view.text, /Checking for updates/);
    assert.equal(view.canInstall, false);
    assert.equal(view.isBusy, true);
});

test('describeUpdateStatus surfaces the available version and stays busy', () => {
    const view = describeUpdateStatus({ status: UPDATE_STATUS.AVAILABLE, version: '2.1.0' });
    assert.match(view.text, /Update available \(v2\.1\.0\)/);
    assert.equal(view.canInstall, false);
    assert.equal(view.isBusy, true);
});

test('describeUpdateStatus shows clamped download progress', () => {
    const view = describeUpdateStatus({ status: UPDATE_STATUS.DOWNLOADING, percent: 33.4 });
    assert.match(view.text, /33%/);
    assert.equal(view.isBusy, true);
    assert.equal(view.canInstall, false);
});

test('describeUpdateStatus flags a downloaded update as installable', () => {
    const view = describeUpdateStatus({ status: UPDATE_STATUS.DOWNLOADED, version: '2.1.0' });
    assert.match(view.text, /Update ready \(v2\.1\.0\)\. Restart to install\./);
    assert.equal(view.canInstall, true);
    assert.equal(view.isBusy, false);
});

test('describeUpdateStatus reports not-available and errors without install controls', () => {
    const latest = describeUpdateStatus({ status: UPDATE_STATUS.NOT_AVAILABLE });
    assert.match(latest.text, /latest version/);
    assert.equal(latest.canInstall, false);

    const failed = describeUpdateStatus({ status: UPDATE_STATUS.ERROR, message: 'network down' });
    assert.match(failed.text, /Update check failed: network down/);
    assert.equal(failed.canInstall, false);
    assert.equal(failed.isBusy, false);
});

test('describeUpdateStatus is defensive against missing/unknown state', () => {
    assert.equal(describeUpdateStatus().text, '');
    assert.equal(describeUpdateStatus().text, '');
    assert.equal(describeUpdateStatus({ status: 'bogus' }).text, '');
});
