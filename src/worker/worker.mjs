// SFMC Data Loader worker — runs exactly one sfmc-dataloader job per process.
//
// It is launched with Electron's `utilityProcess.fork`, so it executes in a
// Node.js environment (no Chromium) and talks to the main process over
// `process.parentPort`. One job per process means "cancel" is a clean process
// kill from the parent, and every job gets an isolated heap for large streams.
//
// sfmc-dataloader is a pure-ESM package; this file is therefore `.mjs` and
// pulls the CommonJS shared helpers in via `createRequire`. The job
// orchestration itself lives in the injectable `run-mcdata-job` helper so it
// can be unit-tested without Electron or a live SFMC connection — this file is
// only the thin `parentPort` wiring.

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { buildMcdataArgv } = require('../shared/build-argv.js');
const { createJobRunner } = require('../shared/run-mcdata-job.js');

const parentPort = process.parentPort;

/**
 * Sends a structured message to the main process.
 *
 * @param {object} message
 * @returns {void}
 */
function post(message) {
    parentPort.postMessage(message);
}

const runJob = createJobRunner({
    post,
    buildArgv: buildMcdataArgv,
    importDataloader: () => import('sfmc-dataloader'),
    console,
});

parentPort.on('message', (event) => {
    const message = event.data;
    if (message?.type === 'start' && message.job) {
        runJob(message.job);
    }
});

process.on('uncaughtException', (ex) => {
    post({ type: 'error', message: ex?.message ?? String(ex), stack: ex?.stack });
});
process.on('unhandledRejection', (reason) => {
    const ex = reason instanceof Error ? reason : new Error(String(reason));
    post({ type: 'error', message: ex.message, stack: ex.stack });
});

// Signal readiness so the parent knows it can post the job.
post({ type: 'ready' });
