'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { loadConfig } = require('../src/main/config-service');
const { createJobRunner } = require('../src/shared/run-mcdata-job');

// This file owns its fixtures; no live org credentials, writes, or network calls.
// Retain the small run directory instead of recursively deleting an unregistered tree.
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) {
        continue;
    }
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replace(/[\\/]+$/u, '')
            .toLowerCase(),
        String.raw`f:\temp`,
    );
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-app-integration-'));
fs.writeFileSync(path.join(root, '.owner'), require('node:crypto').randomUUID());
const fixtureRequire = process.env.SFMC_DATALOADER_FIXTURE
    ? createRequire(path.join(process.env.SFMC_DATALOADER_FIXTURE, 'package.json'))
    : require;
const entry = fixtureRequire.resolve('sfmc-dataloader');
const packageRoot = path.resolve(path.dirname(entry), '..');
const identity = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(identity.name, 'sfmc-dataloader');
if (process.env.SFMC_DATALOADER_FIXTURE) {
    const fixtureManifest = fixtureRequire('./package.json');
    assert.equal(
        fixtureManifest.dependencies['sfmc-dataloader'],
        `file:sfmc-dataloader-${identity.version}.tgz`,
        'packed fixture must install its explicitly declared loader tarball',
    );
} else {
    const manifest = require('../package.json');
    const lock = require('../package-lock.json');
    assert.equal(
        lock.packages[''].dependencies['sfmc-dataloader'],
        manifest.dependencies['sfmc-dataloader'],
        'app manifest and lockfile must agree on the intended loader dependency',
    );
    assert.equal(
        identity.version,
        lock.packages['node_modules/sfmc-dataloader'].version,
        'installed loader must match the app lockfile',
    );
}
const dependencyProject = process.env.SFMC_DATALOADER_FIXTURE || path.join(__dirname, '..');
assert.equal(
    fs.realpathSync(packageRoot),
    fs.realpathSync(path.join(dependencyProject, 'node_modules/sfmc-dataloader')),
    'loader must resolve from the intended project, not an ancestor dependency',
);

registerHooks({
    resolve(specifier, context, nextResolve) {
        return specifier === 'sfmc-sdk'
            ? {
                  url: 'data:text/javascript,export default class SDK { constructor() { return globalThis.__appIntegrationSdk; } }',
                  shortCircuit: true,
              }
            : nextResolve(specifier, context);
    },
});
const loader = import(pathToFileURL(entry).href);
const secret = 'IPC_SECRET_SENTINEL_MUST_NOT_ESCAPE';
fs.writeFileSync(
    path.join(root, '.mcdatarc.json'),
    JSON.stringify({ credentials: { C: { businessUnits: { B: 123 } } } }),
);
fs.writeFileSync(
    path.join(root, '.mcdata-auth.json'),
    JSON.stringify({
        C: { client_id: 'synthetic', client_secret: secret, auth_url: 'https://example.invalid/' },
    }),
);

/**
 * Runs the actual package-root main through the app worker's injectable boundary.
 *
 * @param {string[]} selection
 * @returns {Promise.<object[]>}
 */
async function run(selection) {
    const messages = [];
    await createJobRunner({
        post(message) {
            messages.push(message);
        },
        buildArgv: () => [
            'node',
            'mcdata',
            'import',
            'C/B',
            '--project',
            root,
            '--no-backup-before-import',
            ...selection,
        ],
        importDataloader: () => loader,
        console,
    })({ kind: 'import' });
    assert.equal(JSON.stringify(messages).includes(secret), false);
    return messages;
}

test('adopted package-root public API lists connections without reading auth', async (t) => {
    const dl = await loader;
    t.diagnostic(
        `loader ${identity.version}; entry ${entry}; public API ${typeof dl.loadPublicProjectConfig}`,
    );
    if (!process.env.SFMC_DATALOADER_FIXTURE) {
        assert.equal(require('../package.json').dependencies['sfmc-dataloader'], '^3.2.0');
    }
    assert.equal(typeof dl.loadPublicProjectConfig, 'function');
    const configOptions = process.env.SFMC_DATALOADER_FIXTURE
        ? { importDataloader: () => loader }
        : undefined;
    const read = fs.promises.readFile.bind(fs.promises);
    const reads = [];
    t.mock.method(fs.promises, 'readFile', async (file, ...arguments_) => {
        reads.push(String(file));
        return read(file, ...arguments_);
    });
    // Malformed auth proves listing does not parse it; record reads to prove no auth read at all.
    fs.writeFileSync(path.join(root, '.mcdata-auth.json'), secret);
    const result = await loadConfig(root, configOptions);
    assert.equal(result.configured, true);
    assert.deepEqual(result.credentials[0].businessUnits, [{ name: 'B', mid: 123 }]);
    assert.equal(
        reads.some((file) => file.endsWith('-auth.json')),
        false,
    );
    fs.writeFileSync(path.join(root, '.mcdatarc.json'), `{"secret":"${secret}", INVALID`);
    const invalid = await loadConfig(root, configOptions);
    assert.equal(invalid.configured, false);
    assert.match(invalid.message, /Invalid JSON in \.mcdatarc\.json/);
    assert.equal(JSON.stringify(invalid).includes(secret), false);
    // Restore inputs for the transfer regressions below.
    fs.writeFileSync(
        path.join(root, '.mcdatarc.json'),
        JSON.stringify({ credentials: { C: { businessUnits: { B: 123 } } } }),
    );
    fs.writeFileSync(
        path.join(root, '.mcdata-auth.json'),
        JSON.stringify({
            C: {
                client_id: 'synthetic',
                client_secret: secret,
                auth_url: 'https://example.invalid/',
            },
        }),
    );
});

test('released completion outcomes stay nonzero through the app worker boundary', async (t) => {
    let uploads = 0;
    const sdk = {
        rest: {
            get: async () => ({ status: { requestStatus: 'Complete' } }),
            put: async () => {
                uploads++;
                return { requestId: 'synthetic-request' };
            },
        },
        soap: {
            perform: async () => {
                assert.fail('unexpected CLEAR');
            },
        },
    };
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- Test-only SDK injection consumed by the module hook; restored after the case.
    globalThis.__appIntegrationSdk = sdk;
    t.after(() => {
        delete globalThis.__appIntegrationSdk;
    });
    const source = path.join(root, 'A.mcdata.csv');
    fs.writeFileSync(source, 'id\n1\n');
    t.mock.method(globalThis, 'setTimeout', (callback) => {
        queueMicrotask(callback);
    });
    for (const outcome of [
        'Complete',
        'missing-id',
        'missing-status',
        'status-error',
        'Cancelled',
        'Error',
    ]) {
        sdk.rest.put = async () => {
            uploads++;
            return outcome === 'missing-id' ? {} : { requestId: 'synthetic-request' };
        };
        sdk.rest.get = async () => {
            if (outcome === 'status-error') {
                throw new Error('synthetic status failure');
            }
            return outcome === 'missing-status' ? {} : { status: { requestStatus: outcome } };
        };
        const messages = await run(['--file', source]);
        assert.deepEqual(
            messages.at(-1),
            { type: 'complete', exitCode: outcome === 'Complete' ? 0 : 1 },
            outcome,
        );
        if (outcome !== 'Complete') {
            assert.match(JSON.stringify(messages), /unverified|failed|error|cancelled/i);
        }
    }
    assert.equal(uploads, 6);
});

test('ambiguous explicit files reject once before any SDK effect or automatic retry', async (t) => {
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- Test-only SDK injection; any operation must fail this preflight regression.
    globalThis.__appIntegrationSdk = new Proxy(
        {},
        {
            get() {
                assert.fail('SDK used before ambiguous selection rejected');
            },
        },
    );
    t.after(() => {
        delete globalThis.__appIntegrationSdk;
    });
    const files = ['A.mcdata.2026-01-01.csv', 'A.mcdata.2027-01-01.csv'].map((name) =>
        path.join(root, name),
    );
    for (const file of files) {
        fs.writeFileSync(file, 'id\n1\n');
    }
    const messages = await run([
        ...files.flatMap((file) => ['--file', file]),
        '--clear-before-import',
        '--i-accept-clear-data-risk',
    ]);
    assert.deepEqual(messages.at(-1), { type: 'complete', exitCode: 1 });
    assert.equal(messages.filter((message) => message.type === 'complete').length, 1);
    assert.match(JSON.stringify(messages), /Ambiguous explicit import selection/);
});
