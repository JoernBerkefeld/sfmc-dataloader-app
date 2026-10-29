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
    require('./fixtures/temporary-preflight').assertTemporaryEnvironment();
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

test('setConsent requires a strict affirmative boolean', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();

    await store.setConsent(0);
    assert.equal(store.getConsent(), false);

    await store.setConsent('yes');
    assert.equal(store.getConsent(), false);
});

test('getState returns a renderer-safe snapshot', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '2.5.0' });
    await store.init();

    const snapshot = store.getState();
    assert.deepEqual(
        Object.keys(snapshot).toSorted((a, b) => a.localeCompare(b)),
        ['clientId', 'consent', 'persistence', 'projectRoot', 'transferDefaults', 'version'],
    );
    assert.equal(snapshot.version, '2.5.0');
    assert.equal(snapshot.consent, undefined);
    assert.equal(snapshot.projectRoot, '');
    assert.equal(snapshot.clientId, store.getClientId());
});

test('setProjectRoot persists the folder and survives a reload', async () => {
    const filePath = await temporarySettingsPath();

    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    assert.equal(store.getProjectRoot(), '');

    const state = await store.setProjectRoot('/home/me/project');
    assert.equal(state.projectRoot, '/home/me/project');
    assert.equal(store.getProjectRoot(), '/home/me/project');

    const reloaded = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await reloaded.init();
    assert.equal(reloaded.getProjectRoot(), '/home/me/project');
    assert.equal(reloaded.getState().projectRoot, '/home/me/project');
});

test('setProjectRoot coerces a non-string to an empty string', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();

    await store.setProjectRoot('/tmp/x');
    assert.equal(store.getProjectRoot(), '/tmp/x');

    await store.setProjectRoot(undefined);
    assert.equal(store.getProjectRoot(), '');
});

test('the project folder is preserved across an update', async () => {
    const filePath = await temporarySettingsPath();

    const first = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await first.init();
    await first.setProjectRoot('/data/mcproject');

    const upgraded = new SettingsStore({ filePath, currentVersion: '1.1.0' });
    const upgradedResult = await upgraded.init();
    assert.equal(upgradedResult.event, LIFECYCLE.UPDATE);
    assert.equal(upgraded.getProjectRoot(), '/data/mcproject');
});

test('failed saves retain session choices, expose failure and retry to disk', async () => {
    const filePath = await temporarySettingsPath();
    let isFails = false;
    const store = new SettingsStore({
        filePath,
        currentVersion: '1.0.0',
        writeFile: (...arguments_) => {
            if (isFails) {
                throw new Error('private filesystem detail');
            }
            return fs.writeFile(...arguments_);
        },
    });
    await store.init();
    await store.setConsent(true);
    isFails = true;
    const declined = await store.setConsent(false);
    assert.equal(declined.consent, false);
    assert.equal(store.getConsent(), false);
    assert.equal(declined.persistence.saved, false);
    assert.equal(declined.persistence.error, 'Could not write app settings.');
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).telemetryConsent, true);
    const project = await store.setProjectRoot('F:/session-project');
    assert.equal(project.persistence.saved, false);
    assert.equal(store.getProjectRoot(), 'F:/session-project');
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).projectRoot, '');
    isFails = false;
    const retry = await store.setConsent(false);
    assert.equal(retry.persistence.saved, true);
    assert.equal(retry.persistence.error, undefined);
    const restarted = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await restarted.init();
    assert.equal(restarted.getConsent(), false);
    assert.equal(restarted.getProjectRoot(), 'F:/session-project');
});

test('startup write failures are explicit without preventing startup', async () => {
    const store = new SettingsStore({
        filePath: await temporarySettingsPath(),
        currentVersion: '1.0.0',
        writeFile: async () => {
            throw new Error('write failed');
        },
    });
    const initial = await store.init();
    assert.equal(initial.persistence.saved, false);
    assert.equal(store.getState().persistence.saved, false);
});

test('overlapping saves serialize and never report newer session choices as saved early', async () => {
    const filePath = await temporarySettingsPath();
    const writes = [];
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    store._writeFile = async (...arguments_) => {
        const deferred = Promise.withResolvers();
        writes.push(deferred);
        await deferred.promise;
        return fs.writeFile(...arguments_);
    };
    const first = store.setConsent(true);
    const second = store.setConsent(false);
    await new Promise(setImmediate);
    assert.equal(writes.length, 1);
    writes[0].resolve();
    const firstResult = await first;
    assert.equal(firstResult.persistence.saved, false);
    await new Promise(setImmediate);
    writes[1].resolve();
    const secondResult = await second;
    assert.equal(secondResult.persistence.saved, true);
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).telemetryConsent, false);
});

test('legacy settings migrate to unchanged safe transfer defaults', async () => {
    const filePath = await temporarySettingsPath();
    await fs.writeFile(
        filePath,
        JSON.stringify({
            clientId: 'existing',
            projectRoot: 'F:/project',
            telemetryConsent: false,
        }),
    );
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    assert.deepEqual(store.getState().transferDefaults, {
        format: 'csv',
        git: false,
        mode: 'upsert',
        backupBeforeImport: true,
        skipEmptyLines: true,
        debug: false,
    });
    assert.equal(store.getConsent(), false);
    assert.equal(store.getProjectRoot(), 'F:/project');
});

test('safe defaults survive restart without secrets or destructive choices', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    const safe = {
        format: 'json',
        git: true,
        mode: 'insert',
        backupBeforeImport: false,
        skipEmptyLines: true,
        debug: true,
    };
    const result = await store.setTransferDefaults({
        ...safe,
        clientSecret: 'secret',
        clearBeforeImport: true,
        acceptClearDataRisk: true,
    });
    assert.equal(result.persistence.saved, true);
    result.transferDefaults.format = 'tsv';
    assert.deepEqual(store.getState().transferDefaults, safe);
    const restarted = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await restarted.init();
    assert.deepEqual(restarted.getState().transferDefaults, safe);
    const contents = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(contents, /secret|clearBeforeImport|acceptClearDataRisk/);
});

test('invalid default types normalize safely and failed saves retain session defaults for retry', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    await store.setTransferDefaults({
        format: 'bad',
        mode: 'delete',
        git: 'true',
        backupBeforeImport: 0,
        skipEmptyLines: 1,
        debug: 'true',
    });
    assert.deepEqual(store.getState().transferDefaults, {
        format: 'csv',
        git: false,
        mode: 'upsert',
        backupBeforeImport: true,
        skipEmptyLines: true,
        debug: false,
    });
    store._writeFile = async () => {
        throw new Error('private');
    };
    const result = await store.setTransferDefaults({ format: 'tsv', debug: true });
    assert.equal(result.persistence.saved, false);
    assert.equal(result.transferDefaults.format, 'tsv');
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).transferDefaults.format, 'csv');
    store._writeFile = fs.writeFile;
    const retry = await store.setTransferDefaults(result.transferDefaults);
    assert.equal(retry.persistence.saved, true);
    const restarted = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await restarted.init();
    assert.equal(restarted.getState().transferDefaults.debug, true);
});

test('legacy opt-ins require renewed consent while explicit declines remain declined', async () => {
    for (const legacy of [true, false]) {
        const filePath = await temporarySettingsPath();
        await fs.writeFile(
            filePath,
            JSON.stringify({ clientId: 'pseudonym', telemetryConsent: legacy }),
        );
        const store = new SettingsStore({ filePath, currentVersion: '2.0.0' });
        await store.init();
        assert.equal(store.getConsent(), legacy ? undefined : false);
        assert.equal(store.getClientId(), 'pseudonym');
        assert.equal(store.getState().persistence.saved, true);
        const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
        assert.equal(disk.telemetryConsentVersion, 1);
        assert.equal(disk.telemetryFirstConsentedRun, false);
    }
});

test('only a saved affirmative choice records the first consenting run across restart and upgrade', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    const declined = await store.setConsent(false);
    const accepted = await store.setConsent(true);
    assert.equal(declined.firstConsentedRun, false);
    assert.equal(accepted.firstConsentedRun, true);
    const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(disk.telemetryConsentVersion, 1);
    assert.equal(disk.telemetryFirstConsentedRun, true);
    const upgraded = new SettingsStore({ filePath, currentVersion: '2.0.0' });
    await upgraded.init();
    assert.equal(upgraded.getConsent(), true);
    await upgraded.setConsent(false);
    const renewed = await upgraded.setConsent(true);
    assert.equal(renewed.firstConsentedRun, false);
    assert.equal(upgraded.getClientId(), store.getClientId());
});

test('affirmative consent is inactive while saving and fails closed without later replay', async () => {
    const store = new SettingsStore({
        filePath: await temporarySettingsPath(),
        currentVersion: '1.0.0',
    });
    await store.init();
    const deferred = Promise.withResolvers();
    store._writeFile = () => deferred.promise;
    const accepting = store.setConsent(true);
    assert.equal(store.getConsent(), undefined);
    deferred.reject(new Error('private'));
    const result = await accepting;
    assert.equal(result.consent, undefined);
    assert.equal(result.persistence.saved, false);
    assert.equal(result.firstConsentedRun, false);
    store._writeFile = fs.writeFile;
    await store.setProjectRoot('F:/project');
    assert.equal(store.getConsent(), undefined);
    const retried = await store.setConsent(true);
    assert.equal(retried.firstConsentedRun, true);
    const denial = Promise.withResolvers();
    store._writeFile = () => denial.promise;
    const declining = store.setConsent(false);
    assert.equal(store.getConsent(), false);
    denial.reject(new Error('denial write failed'));
    const declined = await declining;
    assert.equal(declined.persistence.saved, false);
    assert.equal(store.getConsent(), false);
});

test('an unrelated overlapping save cannot persist an unsaved affirmative candidate', async () => {
    const filePath = await temporarySettingsPath();
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    const deferred = Promise.withResolvers();
    let writes = 0;
    store._writeFile = async (...arguments_) => {
        if (++writes === 1) {
            await deferred.promise;
        }
        return fs.writeFile(...arguments_);
    };
    const accepting = store.setConsent(true);
    const savingProject = store.setProjectRoot('F:/project');
    deferred.reject(new Error('failed affirmative candidate'));
    await accepting;
    await savingProject;
    assert.equal(store.getConsent(), undefined);
    const restarted = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await restarted.init();
    assert.equal(restarted.getConsent(), undefined);
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).telemetryFirstConsentedRun, false);
});

test('empty-record migration resets only the legacy preference once, preserving later opt-outs', async () => {
    const filePath = await temporarySettingsPath();
    await fs.writeFile(
        filePath,
        JSON.stringify({
            clientId: 'existing',
            projectRoot: 'F:/project',
            telemetryConsent: false,
            transferDefaults: {
                format: 'tsv',
                git: true,
                mode: 'insert',
                backupBeforeImport: false,
                skipEmptyLines: false,
                debug: true,
            },
        }),
    );
    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await store.init();
    const expected = {
        format: 'tsv',
        git: true,
        mode: 'insert',
        backupBeforeImport: false,
        skipEmptyLines: true,
        debug: true,
    };
    assert.deepEqual(store.getState().transferDefaults, expected);
    assert.equal(store.getProjectRoot(), 'F:/project');
    assert.equal(store.getConsent(), false);
    assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).emptyRecordsMigrationVersion, 1);
    await store.setTransferDefaults({ ...expected, skipEmptyLines: false });
    for (const currentVersion of ['1.0.0', '2.0.0']) {
        const restarted = new SettingsStore({ filePath, currentVersion });
        await restarted.init();
        assert.deepEqual(restarted.getState().transferDefaults, {
            ...expected,
            skipEmptyLines: false,
        });
    }
});

test('a corrupt settings file is tolerated as a fresh install', async () => {
    const filePath = await temporarySettingsPath();
    await fs.writeFile(filePath, '{ not valid json', 'utf8');

    const store = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    const result = await store.init();

    assert.equal(result.event, LIFECYCLE.INSTALL);
    assert.match(store.getClientId(), /^[0-9a-f-]{36}$/);
});
