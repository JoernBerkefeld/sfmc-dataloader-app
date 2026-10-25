'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

test(
    'Electron utility workers explicitly exit after successful and handled-error mocked work',
    { timeout: 60_000 },
    async () => {
        const valid = (value) =>
            typeof value === 'string' &&
            path.isAbsolute(value) &&
            path
                .resolve(value)
                .replace(/[\\/]+$/, '')
                .toLowerCase() === String.raw`f:\temp`;
        assert.ok(valid(process.env.TEMP) && valid(os.tmpdir()));
        for (const name of ['TMP', 'TMPDIR']) {
            const value = process.env[name];
            assert.ok(!value || valid(value));
        }
        // No recursive cleanup: leave this isolated run root for OS temp maintenance.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-lifecycle-'));
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = spawn(
            require('electron'),
            [`--user-data-dir=${root}`, path.join(__dirname, 'fixtures/lifecycle-electron.cjs')],
            { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += chunk;
        });
        child.stderr.on('data', (chunk) => {
            output += chunk;
        });
        const timer = setTimeout(() => child.kill(), 50_000);
        try {
            const code = await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', resolve);
            });
            assert.equal(code, 0, output);
            assert.match(output, /LIFECYCLE_ELECTRON_OK/);
        } finally {
            clearTimeout(timer);
        }
    },
);
