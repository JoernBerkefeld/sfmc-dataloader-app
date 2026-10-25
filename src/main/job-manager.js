'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { utilityProcess } = require('electron');
const { CHANNELS, JOB_KIND } = require('../shared/channels');

const WORKER_PATH = path.join(__dirname, '..', 'worker', 'worker.mjs');

/**
 * Infers the coarse file format from a path extension, for the opt-in usage
 * events. Returns undefined when it is not one of the known formats so the
 * telemetry firewall can normalise it to 'other'.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
function inferFormatFromPath(filePath) {
    const extension = path.extname(String(filePath)).replace('.', '').toLowerCase();
    return ['csv', 'tsv', 'json'].includes(extension) ? extension : undefined;
}

/**
 * Owns the lifecycle of background job processes. Each job runs in its own
 * `utilityProcess` (Node.js, no Chromium) so heavy streaming never blocks the
 * UI and cancelling a job is a clean process kill. Events from the worker are
 * relayed to the renderer over the job:* one-way channels.
 */
class JobManager {
    /**
     * @param {() => import('electron').WebContents | null} getWebContents
     * @param {import('./analytics').Analytics} [analytics] - optional telemetry sink
     */
    constructor(getWebContents, analytics) {
        /**
         * @type {() => import('electron').WebContents | null}
         */
        this._getWebContents = getWebContents;
        /**
         * @type {import('./analytics').Analytics | undefined}
         */
        this._analytics = analytics;
        /**
         * @type {Map<string, {child: import('electron').UtilityProcess, started: boolean, cancelling: boolean, outcome?: {channel: string, payload: object}}> }
         */
        this._jobs = new Map();
        /**
         * @type {Map<string, { kind: string, peakRows: number }>}
         */
        this._jobMeta = new Map();
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
        const state = this._jobs.get(jobId);
        if (!state || state.outcome || state.cancelling) {
            return;
        }
        switch (message?.type) {
            case 'ready': {
                if (!state.started) {
                    state.started = true;
                    state.child.postMessage({ type: 'start', job });
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
                this.#trackPeakRows(jobId, message.event);
                this.#emit(CHANNELS.JOB_PROGRESS, { jobId, event: message.event });
                break;
            }
            case 'complete': {
                state.outcome = {
                    channel: CHANNELS.JOB_COMPLETE,
                    payload: { jobId, exitCode: message.exitCode },
                };
                this.#requestShutdown(jobId, state);
                break;
            }
            case 'error': {
                state.outcome = {
                    channel: CHANNELS.JOB_ERROR,
                    payload: {
                        jobId,
                        message: message.message,
                        stack: message.stack,
                    },
                };
                this.#requestShutdown(jobId, state);
                break;
            }
            // no default — unknown message types are ignored on purpose
        }
    }

    /**
     * Acknowledges terminal delivery; keep the cancel control usable if IPC fails.
     *
     * @param {string} jobId
     * @param {object} state
     * @returns {void}
     */
    #requestShutdown(jobId, state) {
        try {
            state.child.postMessage({ type: 'shutdown' });
        } catch {
            this.#emit(CHANNELS.JOB_LOG, {
                jobId,
                level: 'warn',
                line: 'Worker shutdown request failed. Use Cancel to stop it; no new job can start until it exits.',
            });
        }
    }

    /**
     * Records the peak row count seen for a job from progress events, used later
     * for the `job_outcome` row_count_bucket. Only bucketed at send time, so the
     * raw peak never leaves the process.
     *
     * @param {string} jobId
     * @param {object} event - a ProgressEvent from parse-progress
     * @returns {void}
     */
    #trackPeakRows(jobId, event) {
        const meta = this._jobMeta.get(jobId);
        if (!meta || !event) {
            return;
        }
        const records = typeof event.records === 'number' ? event.records : 0;
        if (records > meta.peakRows) {
            meta.peakRows = records;
        }
    }

    /**
     * Fires the opt-in `job_outcome` event once, then forgets the job's meta.
     * Non-blocking and consent-gated inside the analytics service.
     *
     * @param {string} jobId
     * @param {'success'|'error'|'cancelled'} result
     * @returns {void}
     */
    #trackOutcome(jobId, result) {
        const meta = this._jobMeta.get(jobId);
        if (!meta) {
            return;
        }
        this._jobMeta.delete(jobId);
        this._analytics?.trackJobOutcome({
            kind: meta.kind,
            result,
            rowCount: meta.peakRows,
        });
    }

    /**
     * Emits the opt-in export/import usage event for a job at start time. All
     * values are counts/enums; nothing identifying is derived from the job.
     *
     * @param {object} job - structured McdataJob
     * @returns {Promise.<void>}
     */
    async #trackJobStart(job) {
        if (!this._analytics) {
            return;
        }
        const deKeys = Array.isArray(job.deKeys) ? job.deKeys : [];
        const filePaths = Array.isArray(job.filePaths) ? job.filePaths : [];

        if (job.kind === JOB_KIND.EXPORT || job.kind === JOB_KIND.EXPORT_MULTI_BU) {
            this._analytics.trackExport({
                format: job.format,
                deCount: deKeys.length,
                multiBu: job.kind === JOB_KIND.EXPORT_MULTI_BU,
            });
            return;
        }

        if (job.kind === JOB_KIND.IMPORT || job.kind === JOB_KIND.IMPORT_CROSS_BU) {
            const isCrossBu = job.kind === JOB_KIND.IMPORT_CROSS_BU;
            const targetCount = isCrossBu && Array.isArray(job.to) ? job.to.length : 1;
            const deCount = deKeys.length > 0 ? deKeys.length * targetCount : targetCount;
            const format =
                job.format ??
                (filePaths.length > 0 ? inferFormatFromPath(filePaths[0]) : undefined);
            // Sum file sizes asynchronously so stat() never blocks; fire the event
            // once sizes are known. A stat failure contributes 0 bytes.
            const totalBytes = await this.#sumFileSizes(filePaths);
            this._analytics?.trackImport({
                format,
                deCount,
                fileCount: filePaths.length,
                totalBytes,
                mode: job.mode,
                crossBu: isCrossBu,
            });
        }
    }

    /**
     * Sums the byte sizes of the given files, tolerating unreadable files as 0.
     * Fully async — never blocks the main thread.
     *
     * @param {string[]} filePaths
     * @returns {Promise.<number>}
     */
    async #sumFileSizes(filePaths) {
        if (filePaths.length === 0) {
            return 0;
        }
        const sizes = await Promise.all(
            filePaths.map(async (filePath) => {
                try {
                    const stats = await fs.stat(filePath);
                    return stats.size;
                } catch {
                    return 0;
                }
            }),
        );
        return sizes.reduce((sum, size) => sum + size, 0);
    }

    /**
     * Starts a job in a fresh worker process.
     *
     * @param {object} job - structured McdataJob
     * @returns {{ jobId: string }}
     */
    start(job) {
        if (this._jobs.size > 0) {
            throw new Error(
                'A job is still starting, running or stopping. Wait for it to exit before starting a transfer or saving a connection.',
            );
        }
        const jobId = crypto.randomUUID();
        const child = utilityProcess.fork(WORKER_PATH, [], {
            serviceName: 'sfmc-dataloader-job',
            stdio: 'ignore',
        });
        const state = { child, started: false, cancelling: false, outcome: undefined };
        this._jobs.set(jobId, state);
        this._jobMeta.set(jobId, { kind: job?.kind, peakRows: 0 });
        this.#trackJobStart(job);

        child.on('message', (message) => {
            this.#handleWorkerMessage(jobId, job, message);
        });

        child.on('exit', (code) => {
            if (this._jobs.get(jobId) !== state) {
                return;
            }
            this._jobs.delete(jobId);
            const outcome =
                state.outcome ??
                (state.cancelling
                    ? { channel: CHANNELS.JOB_COMPLETE, payload: { jobId, cancelled: true } }
                    : {
                          channel: CHANNELS.JOB_ERROR,
                          payload: {
                              jobId,
                              message: `Worker exited without a result (code ${code}).`,
                          },
                      });
            let result = 'error';
            if (outcome.payload.cancelled) {
                result = 'cancelled';
            } else if (
                outcome.channel === CHANNELS.JOB_COMPLETE &&
                outcome.payload.exitCode === 0
            ) {
                result = 'success';
            }
            this.#trackOutcome(jobId, result);
            this.#emit(outcome.channel, outcome.payload);
        });

        return { jobId };
    }

    /**
     * Cancels a running job by killing its worker process.
     *
     * @param {string} jobId
     * @returns {boolean} true if a stop request was accepted; ownership ends only on exit
     */
    cancel(jobId) {
        const state = this._jobs.get(jobId);
        if (!state) {
            return false;
        }
        const wasCancelling = state.cancelling;
        state.cancelling = true;
        try {
            if (!state.child.kill()) {
                state.cancelling = wasCancelling;
                return false;
            }
        } catch (ex) {
            state.cancelling = wasCancelling;
            throw ex;
        }
        return true;
    }

    /**
     * Kills every running job (used on app shutdown).
     *
     * @returns {void}
     */
    cancelAll() {
        for (const jobId of this._jobs.keys()) {
            this.cancel(jobId);
        }
    }
}

module.exports = { JobManager };
