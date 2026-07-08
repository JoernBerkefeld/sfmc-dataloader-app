'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, LIFECYCLE } = require('../src/main/settings-store');

/**
 * Creates a unique, non-existent settings file path inside a fresh temp dir so
 * each test starts from a clean "first run" state.
 *
 * @returns {Promise.<string>} absolute path to a settings.json that does not exist yet
 */
async function temporarySettingsPath() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sfmc-settings-'));
    return path.join(directory, 'settings.json');
}

test('init on a missing file reports an install and mints a client id', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });

    const result = await store.init();

    assert.equal(result.event, LIFECYCLE.INSTALL);
    assert.equal(result.previousVersion, undefined);
    assert.match(result.clientId, /^[0-9a-f-]{36}$/);
    assert.equal(store.getClientId(), result.clientId);
    assert.equal(store.getConsent(), undefined);

    // File is persisted with the current version + a stable clientId.
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(persisted.clientId, result.clientId);
    assert.equal(persisted.lastVersion, '1.0.0');
    assert.equal(persisted.telemetryConsent, undefined);
});

test('a relaunch at the same version reports launch and keeps the client id', async () => {
    const filePath = await temporarySettingsPath();

    const first = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    const firstResult = await first.init();

    const second = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    const secondResult = await second.init();

    assert.equal(secondResult.event, LIFECYCLE.LAUNCH);
    assert.equal(secondResult.previousVersion, '1.0.0');
    assert.equal(secondResult.clientId, firstResult.clientId);
});

test('a version change reports an update and preserves the client id', async () => {
    const filePath = await temporarySettingsPath();

    const first = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    const firstResult = await first.init();

    const upgraded = new SettingsStore({ filePath, currentVersion: '1.1.0' });
    const upgradedResult = await upgraded.init();

    assert.equal(upgradedResult.event, LIFECYCLE.UPDATE);
    assert.equal(upgradedResult.previousVersion, '1.0.0');
    assert.equal(upgradedResult.clientId, firstResult.clientId);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(persisted.lastVersion, '1.1.0');
});

test('setConsent persists the choice and survives a reload', async () => {
    const filePath = await temporarySettingsPath();

    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    assert.equal(store.getConsent(), undefined);

    const state = await store.setConsent(true);
    assert.equal(state.consent, true);
    assert.equal(store.getConsent(), true);

    const reloaded = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await reloaded.init();
    assert.equal(reloaded.getConsent(), true);
});

test('setConsent coerces truthy/falsy input to a strict boolean', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();

    await store.setConsent(0);
    assert.equal(store.getConsent(), false);

    await store.setConsent('yes');
    assert.equal(store.getConsent(), true);
});

test('getState returns a renderer-safe snapshot', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '2.5.0' });
    await store.init();

    const snapshot = store.getState();
    assert.deepEqual(
        Object.keys(snapshot).toSorted((a, b) => a.localeCompare(b)),
        ['clientId', 'consent', 'version'],
    );
    assert.equal(snapshot.version, '2.5.0');
    assert.equal(snapshot.consent, undefined);
    assert.equal(snapshot.clientId, store.getClientId());
});

test('a corrupt settings file is tolerated as a fresh install', async () => {
    const filePath = await temporarySettingsPath();
    await fs.writeFile(filePath, '{ not valid json', 'utf8');

    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    const result = await store.init();

    assert.equal(result.event, LIFECYCLE.INSTALL);
    assert.match(store.getClientId(), /^[0-9a-f-]{36}$/);
});
