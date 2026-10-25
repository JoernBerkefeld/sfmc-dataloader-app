'use strict';

/* global require, __dirname */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    try {
        await app.whenReady();
        const window = new BrowserWindow({
            width: 900,
            height: 800,
            // Frame-based test synchronization must survive hook/window occlusion.
            webPreferences: { sandbox: true, backgroundThrottling: false },
        });
        await window.loadURL('data:text/html,<button id="outside">Outside</button><main></main>');
        window.focus();
        await window.webContents.insertCSS(
            fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8'),
        );
        const run = (code) => window.webContents.executeJavaScript(code, true);
        // Windows hooks can occlude this window; prove frames still run minimized.
        // Xvfb runners need not provide a window manager supporting minimization.
        if (process.platform === 'win32') {
            const minimized = new Promise((resolve) => window.once('minimize', resolve));
            window.minimize();
            await minimized;
            assert.equal(window.isMinimized(), true);
            await run(
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
            );
            window.restore();
            window.focus();
        }
        const key = async (keyCode, modifiers = []) => {
            window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
            if (keyCode === 'Enter') {
                window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
            }
            window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
            await run(
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
            );
        };
        for (const file of ['ui.js', 'forms.js']) {
            await run(fs.readFileSync(path.join(__dirname, '../../src/renderer', file), 'utf8'));
        }
        await run(`
            globalThis.jobs = [];
            globalThis.saved = [];
            globalThis.target = 'Org/Target';
            globalThis.keys = ['Customers', 'Orders'];
            globalThis.paths = ['C:/imports/customers.csv', 'C:/imports/orders.json'];
            globalThis.McState = { get: () => ({ projectRoot: 'C:/project' }) };
            globalThis.McFileSize = { buildLargeFileWarning: () => '' };
            globalThis.mcdata = {
                JOB_KIND: { IMPORT: 'import', IMPORT_CROSS_BU: 'importCrossBu' },
                getSettings: async () => ({}),
                setTelemetryConsent: async value => { saved.push(value); return { consent: value }; },
            };
            McForms.filePicker = () => ({ wrap: document.createElement('div'), getFiles: () => paths, getSizedFiles: () => [] });
            globalThis.McBuPicker = class {
                element = document.createElement('div');
                onChange() {}
                refresh() {}
                getValue() { return target; }
            };
            globalThis.McDeSelector = class {
                element = document.createElement('div');
                invalidate() {}
                getKeys() { return keys; }
            };
            globalThis.JobRunner = class {
                element = document.createElement('div');
                async start(job) { jobs.push(job); }
            };
            void 0;
        `);
        for (const file of ['import.js', 'settings.js']) {
            await run(
                fs.readFileSync(path.join(__dirname, '../../src/renderer/screens', file), 'utf8'),
            );
        }
        await run(String.raw`
            McScreens.import.mount(document.querySelector('main'));
            globalThis.start = [...document.querySelectorAll('button')].find(node => node.textContent === 'Start import');
            globalThis.mode = document.querySelector('select');
            document.querySelectorAll('input[type=checkbox]')[1].checked = true;
            document.querySelector('textarea').value = 'Org/One\nOrg/Two';
        `);
        for (const mode of ['singleDe', 'singleFile', 'crossApi', 'crossFile']) {
            for (const dismissal of ['cancel', 'escape', 'authorize']) {
                await run(`
                    mode.value = ${JSON.stringify(mode)};
                    mode.dispatchEvent(new Event('change'));
                    start.focus(); start.click(); start.click();
                `);
                assert.equal(await run('document.querySelectorAll("dialog[open]").length'), 1);
                assert.equal(await run('document.activeElement.id'), 'clear-answer');
                const summary = await run('document.querySelector("#clear-targets").textContent');
                assert.match(
                    summary,
                    mode.startsWith('single') ? /Org\/Target/ : /Org\/One, Org\/Two/,
                );
                assert.match(
                    summary,
                    mode.endsWith('File') ? /customers.csv.*orders.json/ : /Customers, Orders/,
                );
                if (mode === 'crossApi') {
                    assert.match(summary, /Source Business Unit: Org\/Target/);
                }
                assert.equal(
                    await run('document.querySelector("dialog").getAttribute("aria-labelledby")'),
                    'clear-title',
                );
                // Native modal inertness blocks programmatic background focus too.
                await run('document.querySelector("#outside").focus()');
                assert.equal(await run('document.activeElement.id'), 'clear-answer');
                for (const answer of [
                    '',
                    ' '.repeat(3),
                    'wrong',
                    ' CLEAR ',
                    'Customers, Orders ',
                ]) {
                    const before = await run('jobs.length');
                    await run(`
                        document.querySelector('#clear-answer').value = ${JSON.stringify(answer)};
                        document.querySelector('#clear-answer').dispatchEvent(new Event('input'));
                        document.querySelector('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
                    `);
                    assert.equal(await run('jobs.length'), before);
                    assert.equal(await run('document.querySelectorAll("dialog[open]").length'), 1);
                }
                if (dismissal === 'cancel') {
                    await run(`document.querySelector('dialog button').click()`);
                } else if (dismissal === 'escape') {
                    await key('Escape');
                } else {
                    await run(`
                        target = 'Changed/BU'; keys.push('MUTATED'); paths.push('changed.csv');
                        document.querySelector('textarea').value = 'Changed/Target';
                        document.querySelector('#clear-answer').value = ${JSON.stringify(mode.endsWith('File') ? 'CLEAR' : 'Customers, Orders')};
                        document.querySelector('#clear-answer').dispatchEvent(new Event('input'));
                    `);
                    const before = await run('jobs.length');
                    await key('Enter');
                    assert.equal(await run('jobs.length'), before + 1);
                    const job = await run('jobs.at(-1)');
                    assert.equal(job.source || job.from || 'Org/Target', 'Org/Target');
                    if (mode.startsWith('cross')) {
                        assert.deepEqual(job.to, ['Org/One', 'Org/Two']);
                    }
                    if (mode.endsWith('File')) {
                        assert.deepEqual(job.filePaths, [
                            'C:/imports/customers.csv',
                            'C:/imports/orders.json',
                        ]);
                    } else {
                        assert.deepEqual(job.deKeys, ['Customers', 'Orders']);
                    }
                    assert.equal(await run('Object.isFrozen(jobs.at(-1))'), true);
                    await run(
                        String.raw`target = 'Org/Target'; keys = ['Customers', 'Orders']; paths = ['C:/imports/customers.csv', 'C:/imports/orders.json']; document.querySelector('textarea').value = 'Org/One\nOrg/Two';`,
                    );
                }
                await run('new Promise(resolve => requestAnimationFrame(resolve))');
                assert.equal(await run('document.querySelectorAll("dialog").length'), 0);
                if (dismissal !== 'authorize') {
                    assert.equal(await run('document.activeElement === start'), true);
                }
            }
        }
        assert.equal(await run('jobs.length'), 4);
        for (const choice of ['escape', 'no', 'yes']) {
            await run(
                `document.querySelector('#outside').focus(); globalThis.consentDone = false; void McSettings.initConsentGate().then(() => { consentDone = true; });`,
            );
            assert.equal(
                await run('document.querySelector("dialog").getAttribute("aria-labelledby")'),
                'consent-title',
            );
            assert.equal(await run('document.activeElement.textContent'), 'No thanks');
            await run('document.querySelector("#outside").focus()');
            assert.equal(await run('document.activeElement.textContent'), 'No thanks');
            await key('Tab');
            assert.equal(
                await run('document.activeElement.textContent'),
                'Enable usage statistics',
            );
            await key('Tab');
            assert.equal(
                await run(
                    'document.activeElement.closest("dialog") !== null || document.activeElement === document.body',
                ),
                true,
            );
            await key('Tab', ['shift']);
            assert.equal(
                await run('document.activeElement.textContent'),
                'Enable usage statistics',
            );
            if (choice === 'escape') {
                await key('Escape');
            } else {
                if (choice === 'no') {
                    await key('Tab', ['shift']);
                }
                await key('Enter');
            }
            await run('new Promise(resolve => requestAnimationFrame(resolve))');
            assert.equal(await run('consentDone'), true);
            assert.equal(await run('document.activeElement.id'), 'outside');
        }
        assert.deepEqual(await run('saved'), [false, true]);
        console.log(
            'DIALOGS_ELECTRON_OK: 4 modes; invalid/cancel/Escape/Enter; frozen targets; native focus/inertness; consent',
        );
        app.exit(0);
    } catch (ex) {
        console.error(ex);
        app.exit(1);
    }
}
main();
