'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CHANNELS } = require('../src/shared/channels');

function setup() {
    const workers = [];
    const sent = [];
    const outcomes = [];
    const filename = path.resolve(__dirname, '../src/main/job-manager.js');
    const localRequire = createRequire(filename);
    const sandbox = {
        require: (name) =>
            name === 'electron'
                ? {
                      utilityProcess: {
                          fork() {
                              // eslint-disable-next-line unicorn/prefer-event-target -- Electron UtilityProcess exposes the EventEmitter interface.
                              const child = new EventEmitter();
                              child.messages = [];
                              child.postMessage = (message) => {
                                  child.messages.push(message);
                              };
                              child.killResult = true;
                              child.kill = () => child.killResult;
                              workers.push(child);
                              return child;
                          },
                      },
                  }
                : localRequire(name),
        module: { exports: {} },
        __dirname: path.dirname(filename),
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const manager = new sandbox.module.exports.JobManager(
        () => ({
            isDestroyed: () => false,
            send: (channel, payload) => {
                sent.push({ channel, payload });
            },
        }),
        {
            trackExport() {},
            trackJobOutcome: (outcome) => {
                outcomes.push(outcome);
            },
        },
    );
    return { manager, workers, sent, outcomes };
}

for (const terminal of [
    { type: 'complete', exitCode: 0 },
    { type: 'complete', exitCode: 1 },
    { type: 'error', message: 'fatal' },
]) {
    test(`owns worker until exit after ${JSON.stringify(terminal)}`, () => {
        const { manager, workers, sent, outcomes } = setup();
        const { jobId } = manager.start({ kind: 'export' });
        const child = workers[0];
        assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
        assert.throws(() => manager.start({ kind: 'init' }), /saving a connection/);
        child.emit('message', { type: 'ready' });
        child.emit('message', { type: 'ready' });
        assert.equal(child.messages.length, 1);
        child.emit('message', terminal);
        child.emit('message', { type: 'error', message: 'duplicate' });
        child.emit('message', { type: 'log', line: 'late' });
        assert.equal(child.messages[1].type, 'shutdown');
        assert.equal(sent.length, 0);
        assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
        child.emit('exit', 0);
        child.emit('exit', 1);
        child.emit('message', terminal);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].payload.jobId, jobId);
        assert.equal(outcomes.length, 1);
        manager.start({ kind: 'export' });
        assert.equal(workers.length, 2);
    });
}

for (const code of [0, 1]) {
    test(`exit ${code} without terminal result is an error`, () => {
        const { manager, workers, sent } = setup();
        manager.start({ kind: 'init' });
        assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
        workers[0].emit('exit', code);
        assert.equal(sent[0].channel, CHANNELS.JOB_ERROR);
        assert.match(sent[0].payload.message, /without a result/);
    });
}

test('failed kill remains owned, allows natural result, and cancellation waits for actual exit', () => {
    const { manager, workers, sent } = setup();
    const { jobId } = manager.start({ kind: 'export' });
    const child = workers[0];
    child.killResult = false;
    assert.equal(manager.cancel(jobId), false);
    assert.equal(sent.length, 0);
    assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
    child.killResult = true;
    assert.equal(manager.cancel(jobId), true);
    child.emit('message', { type: 'ready' });
    child.emit('message', { type: 'complete', exitCode: 0 });
    assert.equal(child.messages.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(manager.cancel(jobId), true);
    assert.throws(() => manager.start({ kind: 'init' }), /still starting/);
    child.emit('exit', 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.cancelled, true);
    assert.equal(manager.cancel(jobId), false);
    manager.start({ kind: 'export' });
});

test('shutdown IPC failure remains owned with visible recovery and preserves received outcome', () => {
    const { manager, workers, sent } = setup();
    const { jobId } = manager.start({ kind: 'export' });
    workers[0].postMessage = () => {
        throw new Error('closed port');
    };
    workers[0].emit('message', { type: 'complete', exitCode: 0 });
    assert.equal(sent[0].channel, CHANNELS.JOB_LOG);
    assert.match(sent[0].payload.line, /Use Cancel/);
    assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
    assert.equal(manager.cancel(jobId), true);
    workers[0].emit('exit', 1);
    assert.equal(sent[1].channel, CHANNELS.JOB_COMPLETE);
    assert.equal(sent[1].payload.exitCode, 0);
});

test('throwing kill remains owned and retryable', () => {
    const { manager, workers, sent } = setup();
    const { jobId } = manager.start({ kind: 'export' });
    workers[0].kill = () => {
        throw new Error('cannot kill');
    };
    assert.throws(() => manager.cancel(jobId), /cannot kill/);
    assert.throws(() => manager.start({ kind: 'export' }), /still starting/);
    workers[0].emit('message', { type: 'error', message: 'natural failure' });
    workers[0].emit('exit', 1);
    assert.equal(sent[0].payload.message, 'natural failure');
});

test('kill failure does not discard a subsequent natural terminal result', () => {
    const { manager, workers, sent } = setup();
    const { jobId } = manager.start({ kind: 'export' });
    workers[0].killResult = false;
    manager.cancel(jobId);
    workers[0].emit('message', { type: 'complete', exitCode: 0 });
    workers[0].emit('exit', 0);
    assert.equal(sent[0].payload.exitCode, 0);
    assert.equal(sent[0].payload.cancelled, undefined);
});
