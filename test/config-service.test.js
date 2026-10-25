'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, fetchDeList } = require('../src/main/config-service');

const mcdevrc = {
    credentials: {
        MyOrg: { eid: 7_280_000, businessUnits: { Parent: 7_280_000, ChildA: 7_280_001 } },
    },
};

test('loadConfig awaits the public API and returns only credential/BU fields', async () => {
    const secret = 'SECRET_SENTINEL';
    const result = await loadConfig('synthetic-project', {
        importDataloader: async () => ({
            async loadPublicProjectConfig(root, { stderr }) {
                assert.equal(root, 'synthetic-project');
                assert.equal(typeof stderr, 'function');
                await Promise.resolve();
                return { mcdevrc, mcdevAuth: secret };
            },
            loadProjectConfig() {
                assert.fail('must never read auth contents');
            },
        }),
    });
    assert.deepEqual(result, {
        configured: true,
        credentials: [
            {
                credential: 'MyOrg',
                eid: 7_280_000,
                businessUnits: [
                    { name: 'Parent', mid: 7_280_000 },
                    { name: 'ChildA', mid: 7_280_001 },
                ],
            },
        ],
        message: '',
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test('loadConfig fails closed on the released baseline without the additive API', async () => {
    const result = await loadConfig('synthetic-project', {
        importDataloader: async () => ({
            loadProjectConfig() {
                assert.fail('unsafe fallback');
            },
        }),
    });
    assert.equal(result.configured, false);
    assert.deepEqual(result.credentials, []);
    assert.match(result.message, /3\.2\.0.*pending/);
});

test('loadConfig treats public config errors as a soft first-run state', async () => {
    const result = await loadConfig('synthetic-project', {
        importDataloader: async () => ({
            async loadPublicProjectConfig() {
                throw new Error('No project config found');
            },
        }),
    });
    assert.equal(result.configured, false);
    assert.deepEqual(result.credentials, []);
    assert.match(result.message, /No project config/);
});

test('loadConfig rejects an empty project root', async () => {
    await assert.rejects(() => loadConfig(''), /project folder/i);
});

test('fetchDeList validates its inputs before authenticating', async () => {
    const missingRoot = await fetchDeList({ credential: 'MyOrg', bu: 'Parent' });
    assert.equal(missingRoot.ok, false);
    assert.match(missingRoot.error, /project folder/i);
    const missingCred = await fetchDeList({ projectRoot: '/tmp/x', bu: 'Parent' });
    assert.equal(missingCred.ok, false);
    assert.match(missingCred.error, /credential/i);
    const missingBu = await fetchDeList({ projectRoot: '/tmp/x', credential: 'MyOrg' });
    assert.equal(missingBu.ok, false);
    assert.match(missingBu.error, /business unit/i);
});
