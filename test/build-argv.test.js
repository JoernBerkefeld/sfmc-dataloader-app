'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMcdataArgv } = require('../src/shared/build-argv');
const { JOB_KIND } = require('../src/shared/channels');

test('init builds credential flags in-process (secrets on argv are worker-only)', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.INIT,
        credential: 'MyOrg',
        clientId: 'cid-123',
        clientSecret: 'sec-456',
        authUrl: 'https://tenant.auth.marketingcloudapis.com/',
        enterpriseId: '7280000',
        overwrite: true,
        projectRoot: '/work/project',
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'init',
        '--credential',
        'MyOrg',
        '--client-id',
        'cid-123',
        '--client-secret',
        'sec-456',
        '--auth-url',
        'https://tenant.auth.marketingcloudapis.com/',
        '--enterprise-id',
        '7280000',
        '--yes',
        '--project',
        '/work/project',
    ]);
});

test('init accepts a numeric enterpriseId and omits --yes when overwrite is false', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.INIT,
        credential: 'MyOrg',
        clientId: 'cid',
        clientSecret: 'sec',
        authUrl: 'https://tenant.auth.marketingcloudapis.com/',
        enterpriseId: 7_280_000,
    });
    assert.equal(argv.includes('--yes'), false);
    assert.deepEqual(argv.slice(-2), ['--enterprise-id', '7280000']);
});

test('init rejects a missing client secret and a non-numeric enterpriseId', () => {
    assert.throws(
        () =>
            buildMcdataArgv({
                kind: JOB_KIND.INIT,
                credential: 'MyOrg',
                clientId: 'cid',
                clientSecret: '',
                authUrl: 'https://tenant.auth.marketingcloudapis.com/',
                enterpriseId: '7280000',
            }),
        /clientSecret is required/,
    );
    assert.throws(
        () =>
            buildMcdataArgv({
                kind: JOB_KIND.INIT,
                credential: 'MyOrg',
                clientId: 'cid',
                clientSecret: 'sec',
                authUrl: 'https://tenant.auth.marketingcloudapis.com/',
                enterpriseId: 'not-a-number',
            }),
        /enterpriseId must be a positive integer/,
    );
});

test('single-BU export builds positional cred/bu + --de + format flags', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.EXPORT,
        source: 'MyOrg/Parent',
        deKeys: ['DE_A', 'DE_B'],
        format: 'tsv',
        jsonPretty: true,
        git: true,
        maxRowsPerFile: 100_000,
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'export',
        'MyOrg/Parent',
        '--de',
        'DE_A',
        '--de',
        'DE_B',
        '--format',
        'tsv',
        '--json-pretty',
        '--git',
        '--max-rows-per-file',
        '100000',
    ]);
});

test('multi-BU export uses repeated --from and no positional', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.EXPORT_MULTI_BU,
        sources: ['MyOrg/BU1', 'MyOrg/BU2'],
        deKeys: ['DE_A'],
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'export',
        '--from',
        'MyOrg/BU1',
        '--from',
        'MyOrg/BU2',
        '--de',
        'DE_A',
    ]);
});

test('single-BU import by DE with upsert and backup flag', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.IMPORT,
        source: 'MyOrg/Parent',
        deKeys: ['DE_A'],
        mode: 'upsert',
        backupBeforeImport: true,
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'import',
        'MyOrg/Parent',
        '--de',
        'DE_A',
        '--mode',
        'upsert',
        '--backup-before-import',
    ]);
});

test('single-BU import by file with explicit no-backup', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.IMPORT,
        source: 'MyOrg/Parent',
        filePaths: ['/tmp/DE_A.mcdata.csv'],
        backupBeforeImport: false,
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'import',
        'MyOrg/Parent',
        '--file',
        '/tmp/DE_A.mcdata.csv',
        '--no-backup-before-import',
    ]);
});

test('clear-before-import always carries the non-interactive risk ack', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.IMPORT,
        source: 'MyOrg/Parent',
        deKeys: ['DE_A'],
        clearBeforeImport: true,
    });
    assert.ok(argv.includes('--clear-before-import'));
    assert.ok(argv.includes('--i-accept-clear-data-risk'));
});

test('cross-BU API import: --from + repeated --to + --de', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.IMPORT_CROSS_BU,
        from: 'MyOrg/Src',
        to: ['MyOrg/Dst1', 'MyOrg/Dst2'],
        deKeys: ['DE_A'],
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'import',
        '--from',
        'MyOrg/Src',
        '--to',
        'MyOrg/Dst1',
        '--to',
        'MyOrg/Dst2',
        '--de',
        'DE_A',
    ]);
});

test('cross-BU file import: repeated --to + --file, no --from', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.IMPORT_CROSS_BU,
        to: ['MyOrg/Dst1'],
        filePaths: ['/tmp/DE_A.mcdata.csv'],
    });
    assert.deepEqual(argv, [
        'node',
        'mcdata',
        'import',
        '--to',
        'MyOrg/Dst1',
        '--file',
        '/tmp/DE_A.mcdata.csv',
    ]);
});

test('projectRoot and debug flags are appended last', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.EXPORT,
        source: 'MyOrg/Parent',
        deKeys: ['DE_A'],
        projectRoot: '/work/project',
        debug: true,
    });
    assert.deepEqual(argv.slice(-3), ['--project', '/work/project', '--debug']);
});

test('never places credentials/secrets on argv', () => {
    const argv = buildMcdataArgv({
        kind: JOB_KIND.EXPORT,
        source: 'MyOrg/Parent',
        deKeys: ['DE_A'],
        // deliberately smuggled fields that must be ignored
        clientId: 'abc',
        clientSecret: 'shh',
    });
    assert.ok(argv.every((a) => !['abc', 'shh', '--client-secret'].includes(a)));
});

test('rejects invalid cred/bu tokens', () => {
    assert.throws(
        () => buildMcdataArgv({ kind: JOB_KIND.EXPORT, source: 'noslash', deKeys: ['DE_A'] }),
        /credential>\/<businessUnit/,
    );
});

test('single-BU import rejects both deKeys and filePaths together', () => {
    assert.throws(
        () =>
            buildMcdataArgv({
                kind: JOB_KIND.IMPORT,
                source: 'MyOrg/Parent',
                deKeys: ['DE_A'],
                filePaths: ['/tmp/x.csv'],
            }),
        /exactly one of deKeys or filePaths/,
    );
});

test('rejects invalid format and non-positive maxRowsPerFile', () => {
    assert.throws(
        () =>
            buildMcdataArgv({
                kind: JOB_KIND.EXPORT,
                source: 'MyOrg/Parent',
                deKeys: ['DE_A'],
                format: 'xml',
            }),
        /Invalid format/,
    );
    assert.throws(
        () =>
            buildMcdataArgv({
                kind: JOB_KIND.EXPORT,
                source: 'MyOrg/Parent',
                deKeys: ['DE_A'],
                maxRowsPerFile: 0,
            }),
        /positive integer/,
    );
});

test('rejects unknown job kind', () => {
    assert.throws(() => buildMcdataArgv({ kind: 'frobnicate' }), /Unsupported job kind/);
});
