'use strict';

/* global require, __dirname */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    try {
        await app.whenReady();
        const window = new BrowserWindow({ width: 900, height: 700, show: false });
        await window.loadURL('data:text/html,<main></main>');
        const run = (code) => window.webContents.executeJavaScript(code);
        await window.webContents.insertCSS(
            fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8'),
        );
        await run(`
            globalThis.handlers = {};
            globalThis.mcdata = {
                startJob: async () => ({ jobId: 'fixture' }),
                onJobLog: fn => { handlers.log = fn; return () => {}; },
                onJobProgress: fn => { handlers.progress = fn; return () => {}; },
                onJobComplete: fn => { handlers.complete = fn; return () => {}; },
                onJobError: fn => { handlers.error = fn; return () => {}; },
            };
            void 0;
        `);
        for (const file of ['ui.js', 'job-runner.js']) {
            await run(fs.readFileSync(path.join(__dirname, '../../src/renderer', file), 'utf8'));
        }
        const evidence = await run(String.raw`(async () => {
            const timings = [];
            const lines = Array.from({ length: 3000 }, (_, index) => 'Synthetic output ' + index + ' '.repeat(80));
            for (let repeat = 0; repeat < 3; repeat++) {
                const legacy = document.createElement('pre');
                legacy.className = 'job-log';
                document.querySelector('main').append(legacy);
                const before = performance.now();
                // Reproduce the pre-slice append/layout-per-message implementation.
                for (const line of lines) {
                    const span = McUI.element('span', { class: 'log-line log-info', text: line + '\n' });
                    legacy.append(span);
                    legacy.scrollTop = legacy.scrollHeight;
                }
                const legacyMs = performance.now() - before;
                legacy.remove();
                const runner = new JobRunner();
                document.querySelector('main').append(runner.element);
                const done = runner.start({ kind: 'export' });
                await Promise.resolve();
                const start = performance.now();
                for (const line of lines) handlers.log({ jobId: 'fixture', level: 'info', line });
                handlers.complete({ jobId: 'fixture', exitCode: 0 });
                await done;
                const boundedMs = performance.now() - start;
                const log = runner.element.querySelector('.job-log');
                timings.push({ legacyMs, boundedMs, retained: log.children.length });
                runner.element.remove();
            }
            const runner = new JobRunner();
            document.querySelector('main').append(runner.element);
            const done = runner.start({ kind: 'export' });
            await Promise.resolve();
            for (let index = 0; index < 300; index++) handlers.log({ jobId: 'fixture', level: 'info', line: 'line ' + index });
            await new Promise(resolve => setTimeout(resolve, 30));
            const log = runner.element.querySelector('.job-log');
            const followed = log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
            log.scrollTop = 100;
            handlers.log({ jobId: 'fixture', level: 'info', line: 'while reading' });
            await new Promise(resolve => setTimeout(resolve, 30));
            const readingTop = log.scrollTop;
            handlers.log({ jobId: 'fixture', level: 'info', line: 'x'.repeat(100000) + 'TAIL' });
            handlers.complete({ jobId: 'fixture', exitCode: 0 });
            await done;
            const final = log.lastElementChild.textContent;
            runner.reset();
            await new Promise(resolve => setTimeout(resolve, 30));
            return { timings, followed, readingTop, finalBytes: final.length * 2, latest: final.endsWith('TAIL\n'), resetNodes: log.children.length };
        })()`);
        assert.equal(evidence.followed, true);
        assert.equal(evidence.readingTop, 100);
        assert.equal(evidence.latest, true);
        assert.ok(evidence.finalBytes <= 8192);
        assert.equal(evidence.resetNodes, 0);
        for (const sample of evidence.timings) {
            assert.ok(sample.retained <= 500);
        }
        console.log('LOGS_ELECTRON_OK ' + JSON.stringify(evidence));
        app.exit(0);
    } catch (ex) {
        console.error(ex);
        app.exit(1);
    }
}
main();
