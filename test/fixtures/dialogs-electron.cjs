'use strict';

/* global require, __dirname */
const { app, BrowserWindow, nativeTheme } = require('electron');
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
        const styles = fs.readFileSync(
            path.join(__dirname, '../../src/renderer/styles.css'),
            'utf8',
        );
        await window.webContents.insertCSS(styles);
        // Chromium conceals visited styles from computed-style reads; verify the shared rule too.
        assert.match(
            styles,
            /\.changelog-text a,\s*\.changelog-text a:visited\s*\{\s*color: var\(--fg\);\s*text-decoration: underline;/,
        );
        const run = (code) => window.webContents.executeJavaScript(code, true);
        const assertModalColors = async (selectors) => {
            for (const theme of ['light', 'dark']) {
                nativeTheme.themeSource = theme;
                const colors = await run(`(() => {
                    const modal = document.querySelector('dialog[open]');
                    return {
                        background: getComputedStyle(modal).backgroundColor,
                        foregrounds: ${JSON.stringify(selectors)}.map(selector => getComputedStyle(modal.querySelector(selector)).color),
                        muted: modal.querySelector('.telemetry-list') ? getComputedStyle(modal.querySelector('.telemetry-list')).color : null,
                        linkDecoration: modal.querySelector('.changelog-text a') ? getComputedStyle(modal.querySelector('.changelog-text a')).textDecorationLine : null,
                    };
                })()`);
                assert.equal(colors.background, 'rgb(37, 37, 38)', `${theme} modal background`);
                assert.deepEqual(
                    colors.foregrounds,
                    selectors.map(() => 'rgb(224, 224, 224)'),
                    `${theme} modal text`,
                );
                if (colors.linkDecoration) {
                    assert.equal(
                        colors.linkDecoration,
                        'underline',
                        `${theme} release link underline`,
                    );
                }
                if (colors.muted) {
                    assert.equal(colors.muted, 'rgb(157, 157, 157)', `${theme} muted list`);
                }
            }
            nativeTheme.themeSource = 'system';
        };
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
        await run(String.raw`
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
                setTelemetryConsent: async value => { saved.push(value); return { consent: value, persistence: { saved: !globalThis.failSave } }; },
            };
            McForms.filePicker = () => ({ wrap: document.createElement('div'), getFiles: () => paths, getSizedFiles: () => [] });
            globalThis.McBuPicker = class {
                element = document.createElement('div');
                constructor(options) {
                    if (options?.multiple) this.element.append(document.createElement('textarea'));
                }
                onChange() {}
                refresh() {}
                getValue() { return target; }
                getValues() { return this.element.querySelector('textarea').value.split(/[,\n]+/).filter(Boolean); }
            };
            globalThis.McDeSelector = class {
                element = document.createElement('div');
                invalidate() {}
                getKeys() { return keys; }
            };
            globalThis.JobRunner = class {
                static subscribeActive(listener) { listener(); }
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
                await assertModalColors(['h2', '#clear-targets']);
                assert.equal(await run('start.disabled'), true);
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
                assert.equal(await run('start.disabled'), false);
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
            await assertModalColors(['h2', '.telemetry-explainer p', '.telemetry-subhead']);
            assert.equal(await run('document.activeElement.textContent'), 'No thanks');
            assert.equal(await run('document.querySelectorAll("dialog input:checked").length'), 0);
            const explanation = await run(
                'document.querySelector("dialog .telemetry-explainer").textContent',
            );
            for (const phrase of [
                'pseudonymous random installation ID that links events from this installation',
                'not guaranteed anonymous',
                "PostHog's EU ingestion endpoint also receives network metadata, including your IP address",
                'No analytics events are sent until affirmative consent is saved',
                'Turn off all telemetry here at any time',
                'Events already delivered cannot be recalled',
                'First consenting run, app updates and launches (not a count of all installs)',
                'App and loader versions, operating system/version, architecture, and installation channel',
                'Export/import usage, job outcomes (including connection setup), and configuration-load/discovery outcomes',
                'project-presence booleans',
                'coarse file/DE/BU-count, size, row-count, and duration buckets',
                'Closed error categories, names, and codes',
                'without its region subtag',
                'Never included in analytics payloads:',
                'File names, folder/project paths, file contents, or row values',
                'Business Unit names/MIDs, tenant identities, credential labels, or DE keys/field names',
                'Credentials, auth URLs, tokens, raw error messages/stacks, or user-supplied names/email addresses',
            ]) {
                assert.ok(explanation.includes(phrase), `Missing consent explanation: ${phrase}`);
            }
            assert.doesNotMatch(
                explanation,
                /Always collected|not your identity|Anything identifying you or your organisation|never region or anything more/,
            );
            await run(
                'globalThis.consentExplanation = document.querySelector("dialog .telemetry-explainer").textContent',
            );
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
        for (const value of [false, true]) {
            await run(`
                globalThis.failSave = true;
                globalThis.consentDone = false;
                void McSettings.initConsentGate().then(() => { consentDone = true; });
            `);
            await run(`document.querySelectorAll('dialog button')[${Number(value)}].click()`);
            assert.equal(await run('consentDone'), false);
            assert.equal(await run('document.querySelectorAll("dialog[open]").length'), 1);
            assert.match(
                await run('document.querySelector("dialog [role=status]").textContent'),
                /disabled this session; choice not saved/,
            );
            await run('globalThis.failSave = false');
            await run(`document.querySelectorAll('dialog button')[${Number(value)}].click()`);
            await run('new Promise(resolve => requestAnimationFrame(resolve))');
            assert.equal(await run('consentDone'), true);
        }
        await run(`
            document.querySelector('main').replaceChildren();
            mcdata.getSettings = async () => ({ consent: true, persistence: { saved: true } });
            McScreens.settings.mount(document.querySelector('main'));
            void McScreens.settings.activate();
        `);
        assert.equal(
            await run('document.querySelector("main .telemetry-explainer").textContent'),
            await run('consentExplanation'),
        );
        assert.equal(
            await run(
                'document.querySelector("main .card:last-child input[type=checkbox]").checked',
            ),
            true,
        );
        await run(`
            globalThis.failSave = false;
            const toggle = document.querySelector('main .card:last-child input[type=checkbox]');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
        `);
        assert.equal(await run('saved.at(-1)'), false);
        assert.equal(
            await run(
                'document.querySelector("main .card:last-child input[type=checkbox]").checked',
            ),
            false,
        );
        assert.match(
            await run('document.querySelector("main .card:last-child [role=status]").textContent'),
            /saved for next launch/,
        );
        await run(fs.readFileSync(path.join(__dirname, '../../src/renderer/changelog.js'), 'utf8'));
        const { selectChangelog } = require('../../src/main/changelog');
        const releaseNotes = selectChangelog(
            '# Changelog\n\n## [2.0.0]\n\n### Changed\n\n**Bold** [release](https://github.com/example/release)\n\n<script>unsafe</script>\n\n## [1.1.0]\n\nSkipped update\n\n## [1.0.0]\n\n**History**\n',
            '2.0.0',
            '1.0.0',
        );
        await run(`globalThis.releaseNotes = ${JSON.stringify(releaseNotes)}`);
        await run(`
            globalThis.acknowledgements = 0;
            globalThis.active = { label: 'Synthetic job' };
            JobRunner.subscribeActive = listener => { globalThis.jobListener = listener; listener(active); return () => {}; };
            mcdata.getChangelog = async () => releaseNotes;
            mcdata.acknowledgeChangelog = async () => { acknowledgements++; return {saved:true}; };
            document.querySelector('#outside').focus();
            void McChangelog.init();
        `);
        assert.equal(await run('document.querySelectorAll("dialog[open]").length'), 0);
        await run(`
            globalThis.blocker = document.createElement('dialog'); document.body.append(blocker); blocker.showModal();
            jobListener(undefined);
        `);
        assert.equal(await run('document.querySelectorAll(".changelog-modal").length'), 0);
        await run(`blocker.close(); blocker.remove(); document.querySelector('#outside').focus();`);
        await run('new Promise(resolve => requestAnimationFrame(resolve))');
        assert.equal(await run('document.querySelectorAll(".changelog-modal[open]").length'), 1);
        await assertModalColors(['h2', '.changelog-text', '.changelog-text a']);
        assert.equal(
            await run('document.querySelector(".changelog-modal details summary").textContent'),
            'Release history',
        );
        assert.deepEqual(
            await run(
                'Array.from(document.querySelectorAll(".changelog-modal details h3"), heading => heading.textContent)',
            ),
            ['Version 1.0.0'],
        );
        assert.equal(
            await run('document.querySelector("#changelog-title").textContent'),
            "What's new",
        );
        assert.equal(
            await run('document.querySelector(".changelog-text h3").textContent'),
            'Changed',
        );
        assert.equal(
            await run('document.querySelector(".changelog-text strong").textContent'),
            'Bold',
        );
        assert.equal(
            await run('document.querySelector(".changelog-text a").href'),
            'https://github.com/example/release',
        );
        assert.equal(
            await run('document.querySelector(".changelog-modal details strong").textContent'),
            'History',
        );
        assert.equal(await run('document.activeElement.textContent'), 'Close changelog');
        assert.equal(
            await run('Boolean(document.querySelector(".changelog-modal script"))'),
            false,
        );
        assert.match(
            await run('document.querySelector(".changelog-text").textContent'),
            /<script>/,
        );
        const dimensions = await run(
            `({width:document.querySelector('.changelog-modal').getBoundingClientRect().width / innerWidth, height:document.querySelector('.changelog-modal').getBoundingClientRect().height / innerHeight})`,
        );
        assert.ok(Math.abs(dimensions.width - 0.8) < 0.01);
        assert.ok(Math.abs(dimensions.height - 0.8) < 0.01);
        for (let index = 0; index < 6; index++) {
            await key('Tab');
        }
        assert.equal(
            await run(
                'document.querySelector(".changelog-modal").contains(document.activeElement)',
            ),
            true,
        );
        assert.equal(await run('acknowledgements'), 0);
        await key('Escape');
        await run('new Promise(resolve => requestAnimationFrame(resolve))');
        assert.equal(await run('acknowledgements'), 1);
        assert.equal(await run('document.activeElement.id'), 'outside');
        await run(`globalThis.active = undefined; void McChangelog.init();`);
        await run('new Promise(resolve => requestAnimationFrame(resolve))');
        await run(`document.querySelector('.changelog-modal button').click()`);
        await run('new Promise(resolve => requestAnimationFrame(resolve))');
        assert.equal(await run('acknowledgements'), 2);
        assert.equal(await run('document.querySelectorAll(".changelog-modal").length'), 0);
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
