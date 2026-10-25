'use strict';

/* global require, __dirname */

const { app, utilityProcess } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function main() {
    try {
        await app.whenReady();
        const filename = path.resolve(__dirname, '../../src/main/job-manager.js');
        const localRequire = createRequire(filename);
        const children = [];
        const sandbox = {
            __dirname: path.dirname(filename),
            module: { exports: {} },
            require: (name) =>
                name === 'electron'
                    ? {
                          utilityProcess: {
                              fork(worker, arguments_, options) {
                                  assert.equal(
                                      worker,
                                      path.resolve(__dirname, '../../src/worker/worker.mjs'),
                                  );
                                  const child = utilityProcess.fork(
                                      path.join(__dirname, 'lifecycle-worker.mjs'),
                                      arguments_,
                                      options,
                                  );
                                  children.push(child);
                                  return child;
                              },
                          },
                      }
                    : localRequire(name),
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
        let resolveOutcome;
        const manager = new sandbox.module.exports.JobManager(() => ({
            isDestroyed: () => false,
            send: (channel, payload) => resolveOutcome({ channel, payload }),
        }));
        for (const key of ['success', 'failure', 'fatal', 'rejection', 'success']) {
            const { promise: pending, resolve } = Promise.withResolvers();
            resolveOutcome = resolve;
            manager.start({ kind: 'export', source: 'mock/bu', deKeys: [key] });
            assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
            const outcome = await pending;
            assert.equal(
                outcome.channel,
                key === 'success' ? 'job:complete' : 'job:error',
                JSON.stringify(outcome),
            );
            if (key === 'success') {
                assert.equal(outcome.payload.exitCode, 0);
            } else {
                assert.match(
                    outcome.payload.message,
                    /Mock (handled failure|fatal exception|unhandled rejection)/,
                );
            }
            assert.equal(manager._jobs.size, 0);
        }
        assert.equal(children.length, 5);
        console.log('LIFECYCLE_ELECTRON_OK');
        app.exit(0);
    } catch (ex) {
        console.error(ex);
        app.exit(1);
    }
}
main();
