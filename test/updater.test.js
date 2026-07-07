'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { UpdaterService } = require('../src/main/updater');
const { CHANNELS } = require('../src/shared/channels');
const { UPDATE_STATUS } = require('../src/shared/update-status');

/** Web contents that is never present — exercises the null-window code path. */
const noWebContents = () => {};

/**
 * Minimal stand-in for electron-updater's AppUpdater. It implements just the
 * `.on()` / `.emit()` surface the service uses (a plain listener registry — no
 * Node EventEmitter needed) plus the two config flags and spy counters for
 * checkForUpdates/quitAndInstall.
 *
 * @returns {Record<string, unknown>} fake updater
 */
function makeFakeUpdater() {
    const listeners = new Map();
    const updater = {
        autoDownload: undefined,
        autoInstallOnAppQuit: undefined,
        checkCalls: 0,
        installCalls: 0,
        on(event, handler) {
            listeners.set(event, handler);
            return updater;
        },
        emit(event, payload) {
            const handler = listeners.get(event);
            if (handler) {
                handler(payload);
            }
        },
        async checkForUpdates() {
            updater.checkCalls += 1;
        },
        quitAndInstall() {
            updater.installCalls += 1;
        },
    };
    return updater;
}

/**
 * Fake WebContents that records every send() so tests can assert what the
 * renderer would have received.
 *
 * @returns {{ sent: { channel: string, payload: object }[], isDestroyed: () => boolean, send: Function }}
 */
function makeFakeWebContents() {
    const sent = [];
    return {
        sent,
        isDestroyed: () => false,
        send: (channel, payload) => {
            sent.push({ channel, payload });
        },
    };
}

test('constructor configures automatic download but manual install', () => {
    const updater = makeFakeUpdater();
    new UpdaterService(noWebContents, { updater, isPackaged: true });
    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
});

test('updater events are forwarded to the renderer as UPDATE_STATUS states', () => {
    const updater = makeFakeUpdater();
    const webContents = makeFakeWebContents();
    const service = new UpdaterService(() => webContents, { updater, isPackaged: true });

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '9.9.9' });
    updater.emit('download-progress', { percent: 55.5 });
    updater.emit('update-downloaded', { version: '9.9.9' });

    const statuses = webContents.sent.map((entry) => entry.payload.status);
    assert.deepEqual(statuses, [
        UPDATE_STATUS.CHECKING,
        UPDATE_STATUS.AVAILABLE,
        UPDATE_STATUS.DOWNLOADING,
        UPDATE_STATUS.DOWNLOADED,
    ]);
    assert.equal(
        webContents.sent.every((entry) => entry.channel === CHANNELS.UPDATE_STATUS),
        true,
    );
    assert.equal(service.getState().status, UPDATE_STATUS.DOWNLOADED);
    assert.equal(service.getState().version, '9.9.9');
});

test('download-progress carries the version captured from update-available', () => {
    const updater = makeFakeUpdater();
    const webContents = makeFakeWebContents();
    new UpdaterService(() => webContents, { updater, isPackaged: true });

    updater.emit('update-available', { version: '3.0.0' });
    updater.emit('download-progress', { percent: 10 });

    const downloading = webContents.sent.at(-1).payload;
    assert.equal(downloading.status, UPDATE_STATUS.DOWNLOADING);
    assert.equal(downloading.version, '3.0.0');
});

test('error events become an ERROR state with a string message', () => {
    const updater = makeFakeUpdater();
    const webContents = makeFakeWebContents();
    const service = new UpdaterService(() => webContents, { updater, isPackaged: true });

    updater.emit('error', new Error('feed unreachable'));

    assert.equal(service.getState().status, UPDATE_STATUS.ERROR);
    assert.equal(service.getState().message, 'feed unreachable');
});

test('checkForUpdates no-ops in an unpackaged build', async () => {
    const updater = makeFakeUpdater();
    const service = new UpdaterService(noWebContents, { updater, isPackaged: false });
    await service.checkForUpdates();
    assert.equal(updater.checkCalls, 0);
});

test('checkForUpdates delegates to the updater when packaged', async () => {
    const updater = makeFakeUpdater();
    const service = new UpdaterService(noWebContents, { updater, isPackaged: true });
    await service.checkForUpdates();
    assert.equal(updater.checkCalls, 1);
});

test('checkForUpdates skips quietly when the updater is inactive (deb/rpm/snap)', async () => {
    const updater = makeFakeUpdater();
    updater.isUpdaterActive = () => false;
    const service = new UpdaterService(noWebContents, { updater, isPackaged: true });
    await service.checkForUpdates();
    assert.equal(updater.checkCalls, 0);
    // No error state is produced — the package manager owns updates here.
    assert.equal(service.getState().status, UPDATE_STATUS.IDLE);
});

test('checkForUpdates proceeds when the updater reports active', async () => {
    const updater = makeFakeUpdater();
    updater.isUpdaterActive = () => true;
    const service = new UpdaterService(noWebContents, { updater, isPackaged: true });
    await service.checkForUpdates();
    assert.equal(updater.checkCalls, 1);
});

test('quitAndInstall only runs once an update is downloaded', () => {
    const updater = makeFakeUpdater();
    const service = new UpdaterService(noWebContents, { updater, isPackaged: true });

    assert.equal(service.quitAndInstall(), false);
    assert.equal(updater.installCalls, 0);

    updater.emit('update-downloaded', { version: '1.2.3' });
    assert.equal(service.quitAndInstall(), true);
    assert.equal(updater.installCalls, 1);
});

test('missing webContents does not throw when emitting state', () => {
    const updater = makeFakeUpdater();
    new UpdaterService(noWebContents, { updater, isPackaged: true });
    assert.doesNotThrow(() => updater.emit('update-not-available', {}));
});
