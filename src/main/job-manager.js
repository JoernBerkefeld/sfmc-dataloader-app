'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { utilityProcess } = require('electron');
const { CHANNELS } = require('../shared/channels');

const WORKER_PATH = path.join(__dirname, '..', 'worker', 'worker.mjs');

/**
 * Owns the lifecycle of background job processes. Each job runs in its own
 * `utilityProcess` (Node.js, no Chromium) so heavy streaming never blocks the
 * UI and cancelling a job is a clean process kill. Events from the worker are
 * relayed to the renderer over the job:* one-way channels.
 */
class JobManager {
    /**
     * @param {() => import('electron').WebContents | null} getWebContents
     */
    constructor(getWebContents) {
        /** @type {() => import('electron').WebContents | null} */
        this._getWebContents = getWebContents;
        /** @type {Map<string, import('electron').UtilityProcess>} */
        this._jobs = new Map();
    }

    /**
     * Forwards an event to the renderer if the window still exists.
     *
     * @param {string} channel
     * @param {object} payload
     * @returns {void}
     */
    #emit(channel, payload) {
        const webContents = this._getWebContents();
        if (webContents && !webContents.isDestroyed()) {
            webContents.send(channel, payload);
        }
    }

    /**
     * @param {string} jobId
     * @param {object} job
     * @param {object} message - message posted by the worker
     * @returns {void}
     */
    #handleWorkerMessage(jobId, job, message) {
        switch (message?.type) {
            case 'ready': {
                const child = this._jobs.get(jobId);
                if (child) {
                    child.postMessage({ type: 'start', job });
                }
                break;
            }
            case 'log': {
                this.#emit(CHANNELS.JOB_LOG, {
                    jobId,
                    level: message.level,
                    line: message.line,
                });
                break;
            }
            case 'progress': {
                this.#emit(CHANNELS.JOB_PROGRESS, { jobId, event: message.event });
                break;
            }
            case 'complete': {
                this._jobs.delete(jobId);
                this.#emit(CHANNELS.JOB_COMPLETE, { jobId, exitCode: message.exitCode });
                break;
            }
            case 'error': {
                this._jobs.delete(jobId);
                this.#emit(CHANNELS.JOB_ERROR, {
                    jobId,
                    message: message.message,
                    stack: message.stack,
                });
                break;
            }
            // no default — unknown message types are ignored on purpose
        }
    }

    /**
     * Starts a job in a fresh worker process.
     *
     * @param {object} job - structured McdataJob
     * @returns {{ jobId: string }}
     */
    start(job) {
        const jobId = crypto.randomUUID();
        const child = utilityProcess.fork(WORKER_PATH, [], {
            serviceName: 'sfmc-dataloader-job',
            stdio: 'ignore',
        });
        this._jobs.set(jobId, child);

        child.on('message', (message) => {
            this.#handleWorkerMessage(jobId, job, message);
        });

        child.on('exit', (code) => {
            // A non-zero exit without a prior complete/error means the worker
            // died unexpectedly (e.g. OOM) or was cancelled.
            if (!this._jobs.has(jobId)) {
                return;
            }

            this._jobs.delete(jobId);
            if (code !== 0) {
                this.#emit(CHANNELS.JOB_ERROR, {
                    jobId,
                    message: `Worker exited unexpectedly (code ${code}).`,
                });
            }
        });

        return { jobId };
    }

    /**
     * Cancels a running job by killing its worker process.
     *
     * @param {string} jobId
     * @returns {boolean} true if a job was found and killed
     */
    cancel(jobId) {
        const child = this._jobs.get(jobId);
        if (!child) {
            return false;
        }
        this._jobs.delete(jobId);
        child.kill();
        this.#emit(CHANNELS.JOB_COMPLETE, { jobId, exitCode: null, cancelled: true });
        return true;
    }

    /**
     * Kills every running job (used on app shutdown).
     *
     * @returns {void}
     */
    cancelAll() {
        for (const child of this._jobs.values()) {
            child.kill();
        }
        this._jobs.clear();
    }
}

module.exports = { JobManager };
