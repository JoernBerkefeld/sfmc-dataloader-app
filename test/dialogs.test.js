'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

test(
    'Native Electron dialogs protect frozen imports and keyboard consent',
    { timeout: 60_000 },
    async () => {
        require('./fixtures/temporary-preflight').assertTemporaryEnvironment();
        // Leave the isolated run root for OS temp maintenance; no recursive cleanup.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-dialogs-'));
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = spawn(
            require('electron'),
            [`--user-data-dir=${root}`, path.join(__dirname, 'fixtures/dialogs-electron.cjs')],
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
            assert.match(output, /DIALOGS_ELECTRON_OK/);
        } finally {
            clearTimeout(timer);
        }
    },
);
