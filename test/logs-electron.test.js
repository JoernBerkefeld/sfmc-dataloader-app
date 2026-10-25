'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

test(
    'isolated Electron log burst rendering and scrolling evidence',
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
        // Retain isolated scratch for OS maintenance, without recursive deletion.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-logs-'));
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = spawn(
            require('electron'),
            [`--user-data-dir=${root}`, path.join(__dirname, 'fixtures/logs-electron.cjs')],
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
            assert.match(output, /LOGS_ELECTRON_OK/);
            console.log(output.match(/LOGS_ELECTRON_OK.*/)[0]);
        } finally {
            clearTimeout(timer);
        }
    },
);
