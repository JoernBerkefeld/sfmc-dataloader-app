'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configService = require('../src/main/config-service');

/**
 * Writes a valid `.mcdatarc.json` / `.mcdata-auth.json` pair into a throwaway
 * project folder and returns its path. Mirrors the shape `mcdata init` writes
 * (see sfmc-dataloader/lib/init-project.mjs).
 *
 * @param {string} secret - the client secret to plant in the auth file
 * @returns {string} the temp project root
 */
function makeProject(secret) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-app-'));
    const rc = {
        credentials: {
            MyOrg: {
                eid: 7_280_000,
                businessUnits: { Parent: 7_280_000, ChildA: 7_280_001 },
            },
        },
    };
    const auth = {
        MyOrg: {
            client_id: 'cid-abc',
            client_secret: secret,
            auth_url: 'https://tenant.auth.marketingcloudapis.com/',
            account_id: 7_280_000,
        },
    };
    fs.writeFileSync(path.join(root, '.mcdatarc.json'), JSON.stringify(rc, null, 4), 'utf8');
    fs.writeFileSync(path.join(root, '.mcdata-auth.json'), JSON.stringify(auth, null, 4), 'utf8');
    return root;
}

test('loadConfig returns a sanitized credential/BU view and never leaks the secret', async () => {
    const secret = 'super-secret-value';
    const root = makeProject(secret);
    try {
        const result = await configService.loadConfig(root);
        assert.equal(result.configured, true);
        assert.equal(result.credentials.length, 1);

        const cred = result.credentials[0];
        assert.equal(cred.credential, 'MyOrg');
        assert.equal(cred.eid, 7_280_000);
        assert.deepEqual(
            cred.businessUnits.map((bu) => bu.name).toSorted((a, b) => a.localeCompare(b)),
            ['ChildA', 'Parent'],
        );

        // The whole serialized result must not contain the client secret.
        assert.equal(JSON.stringify(result).includes(secret), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('loadConfig treats a missing config as a soft, first-run state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-app-empty-'));
    try {
        const result = await configService.loadConfig(root);
        assert.equal(result.configured, false);
        assert.deepEqual(result.credentials, []);
        assert.ok(result.message.length > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('loadConfig rejects an empty project root', async () => {
    await assert.rejects(() => configService.loadConfig(''), /project folder/i);
});

test('fetchDeList validates its inputs before authenticating', async () => {
    const missingRoot = await configService.fetchDeList({ credential: 'MyOrg', bu: 'Parent' });
    assert.equal(missingRoot.ok, false);
    assert.match(missingRoot.error, /project folder/i);

    const missingCred = await configService.fetchDeList({ projectRoot: '/tmp/x', bu: 'Parent' });
    assert.equal(missingCred.ok, false);
    assert.match(missingCred.error, /credential/i);

    const missingBu = await configService.fetchDeList({
        projectRoot: '/tmp/x',
        credential: 'MyOrg',
    });
    assert.equal(missingBu.ok, false);
    assert.match(missingBu.error, /business unit/i);
});
