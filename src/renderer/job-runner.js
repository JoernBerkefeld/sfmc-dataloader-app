'use strict';

// JobRunner drives a single sfmc-dataloader job from the renderer: it starts the
// job through window.mcdata, subscribes to the job:* event stream, and paints a
// live progress bar + scrolling log panel + run/cancel controls. One instance is
// mounted per screen (Export / Import) and reused across runs.
(function initJobRunner(globalObject) {
    const { element, toast, clear } = globalObject.McUI;

    /**
     * Human-readable summary for a structured progress event
     * (see src/shared/parse-progress.js).
     *
     * @param {object} event
     * @returns {string}
     */
    function describeProgress(event) {
        switch (event.phase) {
            case 'download': {
                return event.total
                    ? `Downloading batch ${event.current}/${event.total} (${event.records ?? 0} records)`
                    : `Downloading… (${event.records ?? 0} records so far)`;
            }
            case 'upload': {
                return event.total
                    ? `Uploading batch ${event.current}/${event.total}`
                    : `Uploading batch ${event.current}`;
            }
            case 'exported': {
                return `Exported ${event.records} rows`;
            }
            case 'imported': {
                return `Imported ${event.records} rows`;
            }
            case 'rowCount': {
                return `Row count ${event.when} import: ${event.records}`;
            }
            default: {
                return '';
            }
        }
    }

    // Byte budgets count UTF-16 text storage (two bytes per code unit), including newlines.
    const MAX_PENDING_LINES = 500;
    const MAX_PENDING_BYTES = 256 * 1024;
    const MAX_DISPLAY_LINES = 1000;
    const MAX_DISPLAY_BYTES = 512 * 1024;
    const MAX_LINE_BYTES = 8 * 1024;

    class JobRunner {
        static #activeRunner;
        static #listeners = new Set();
        /**
         * Subscribes to the single active runner without owning its lifecycle.
         *
         * @param {(job: object|undefined) => void} listener
         * @returns {() => void}
         */
        static subscribeActive(listener) {
            JobRunner.#listeners.add(listener);
            const runner = JobRunner.#activeRunner;
            listener(runner ? runner.#snapshot() : undefined);
            return () => JobRunner.#listeners.delete(listener);
        }

        #view;
        #label;

        /**
         * @type {string | undefined}
         */
        #jobId = undefined;
        #starting = false;
        #pendingEvents = [];
        #earlyLogBytes = 0;
        #earlyLogCount = 0;
        #pendingLogs = [];
        #pendingLogBytes = 0;
        #displayedLogs = [];
        #displayedLogBytes = 0;
        #logTimer;
        #droppedOutput = false;
        #logNotice;
        /**
         * @type {() => void[]}
         */
        #unsubscribers = [];
        /**
         * @type {HTMLElement}
         */
        #root;
        /**
         * @type {HTMLElement}
         */
        #fill;
        #bar;
        /**
         * @type {HTMLElement}
         */
        #status;
        /**
         * @type {HTMLElement}
         */
        #log;
        /**
         * @type {HTMLButtonElement}
         */
        #cancelButton;

        /**
         * @param {{ view?: string, label?: string }} [options]
         */
        constructor({ view = 'export', label = 'Export' } = {}) {
            this.#view = view;
            this.#label = label;
            this.#root = this.#build();
        }

        /**
         * @returns {object} Current active-job navigation summary.
         */
        #snapshot() {
            return { view: this.#view, label: this.#label, status: this.#status.textContent };
        }

        /**
         * @returns {void} Publishes only the owning runner's state.
         */
        #publish() {
            if (JobRunner.#activeRunner === this) {
                for (const listener of JobRunner.#listeners) {
                    listener(this.#snapshot());
                }
            }
        }

        /**
         * @returns {void} Releases the renderer-wide slot after a terminal event.
         */
        #release() {
            if (JobRunner.#activeRunner !== this) {
                return;
            }
            JobRunner.#activeRunner = undefined;
            for (const listener of JobRunner.#listeners) {
                listener();
            }
        }

        /**
         * Builds the runner DOM once.
         *
         * @returns {HTMLElement}
         */
        #build() {
            const root = element('div', {
                class: 'job-runner',
                attrs: { tabindex: '-1', role: 'region', 'aria-label': `${this.#label} job` },
            });

            const bar = element('div', {
                class: 'progress',
                attrs: {
                    role: 'progressbar',
                    'aria-label': `${this.#label} job progress`,
                    'aria-valuemin': '0',
                    'aria-valuemax': '100',
                    'aria-valuenow': '0',
                },
            });
            this.#bar = bar;
            this.#fill = element('div', { class: 'progress-fill' });
            bar.append(this.#fill);

            this.#status = element('p', {
                class: 'job-status muted',
                text: 'Idle.',
                attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
            });

            this.#log = element('pre', {
                class: 'job-log',
                attrs: { tabindex: '0', role: 'region', 'aria-label': `${this.#label} job output` },
            });

            this.#cancelButton = /** @type {HTMLButtonElement} */ (
                element('button', {
                    class: 'btn btn-danger',
                    text: 'Cancel',
                    attrs: { type: 'button', disabled: 'true' },
                })
            );
            this.#cancelButton.addEventListener('click', () => this.cancel());

            const controls = element('div', { class: 'job-controls' });
            controls.append(this.#cancelButton);

            this.#logNotice = element('p', {
                class: 'muted',
                text: 'Older output was discarded or an oversized line was truncated; showing recent output only.',
            });
            this.#logNotice.hidden = true;
            root.append(bar, this.#status, controls, this.#logNotice, this.#log);
            return root;
        }

        /**
         * Sets the progress bar fill from a ratio in [0,1]; negative → indeterminate.
         *
         * @param {number} ratio
         * @returns {void}
         */
        #setProgress(ratio) {
            if (ratio < 0) {
                this.#bar.removeAttribute('aria-valuenow');
                this.#fill.classList.add('indeterminate');
                this.#fill.style.width = '40%';
                return;
            }
            this.#fill.classList.remove('indeterminate');
            const clamped = Math.max(0, Math.min(1, ratio));
            const percent = Math.round(clamped * 100);
            this.#bar.setAttribute('aria-valuenow', String(percent));
            this.#fill.style.width = percent + '%';
        }

        /**
         * Caps each incoming line before retaining it, preserving its newest text.
         *
         * @param {object} payload
         * @returns {object}
         */
        #boundedLog(payload) {
            const line = String(payload.line);
            const isTruncated = line.length > MAX_LINE_BYTES / 2 - 1;
            return {
                jobId: payload.jobId,
                level: ['info', 'warn', 'error', 'debug'].includes(payload.level)
                    ? payload.level
                    : 'info',
                // Copy the bounded suffix so a sliced string cannot retain its oversized backing store.
                line: isTruncated
                    ? line
                          .slice(-(MAX_LINE_BYTES / 2 - 2))
                          .split('')
                          .join('')
                    : line,
                truncated: isTruncated,
            };
        }

        /**
         * Queues bounded output for one DOM update per frame-sized interval.
         *
         * @param {string} level
         * @param {string} line
         * @returns {void}
         */
        #appendLog(level, line) {
            const bounded = this.#boundedLog({ level, line });
            this.#droppedOutput ||= bounded.truncated;
            const text = bounded.line + '\n';
            this.#pendingLogs.push({ level, text });
            this.#pendingLogBytes += text.length * 2;
            while (
                this.#pendingLogs.length > MAX_PENDING_LINES ||
                this.#pendingLogBytes > MAX_PENDING_BYTES
            ) {
                this.#pendingLogBytes -= this.#pendingLogs.shift().text.length * 2;
                this.#droppedOutput = true;
            }
            this.#logTimer ??= globalObject.setTimeout(() => this.#flushLogs(), 16);
        }

        /**
         * Flushes final output synchronously too; layout is read only once per batch.
         *
         * @returns {void}
         */
        #flushLogs() {
            globalObject.clearTimeout(this.#logTimer);
            this.#logTimer = undefined;
            if (this.#pendingLogs.length === 0) {
                this.#logNotice.hidden = !this.#droppedOutput;
                return;
            }
            const isFollow =
                this.#log.scrollHeight - this.#log.scrollTop - this.#log.clientHeight <= 48;
            const fragment = globalObject.document.createDocumentFragment();
            for (const { level, text } of this.#pendingLogs) {
                const node = element('span', { class: 'log-line log-' + level, text });
                this.#displayedLogs.push({ node, bytes: text.length * 2 });
                this.#displayedLogBytes += text.length * 2;
                fragment.append(node);
            }
            this.#pendingLogs = [];
            this.#pendingLogBytes = 0;
            while (
                this.#displayedLogs.length > MAX_DISPLAY_LINES ||
                this.#displayedLogBytes > MAX_DISPLAY_BYTES
            ) {
                const { node, bytes } = this.#displayedLogs.shift();
                this.#displayedLogBytes -= bytes;
                node.remove();
                this.#droppedOutput = true;
            }
            this.#log.append(fragment);
            this.#logNotice.hidden = !this.#droppedOutput;
            if (isFollow) {
                this.#log.scrollTop = this.#log.scrollHeight;
            }
        }

        /**
         * Cancels stale scheduled work and releases all retained output.
         *
         * @returns {void}
         */
        #clearLogs() {
            globalObject.clearTimeout(this.#logTimer);
            this.#logTimer = undefined;
            this.#pendingLogs = [];
            this.#pendingLogBytes = 0;
            this.#displayedLogs = [];
            this.#displayedLogBytes = 0;
            this.#earlyLogBytes = 0;
            this.#earlyLogCount = 0;
            this.#droppedOutput = false;
            this.#logNotice.hidden = true;
            clear(this.#log);
        }

        /**
         * Detaches all job:* subscriptions.
         *
         * @returns {void}
         */
        #teardown() {
            for (const off of this.#unsubscribers) {
                off();
            }
            this.#unsubscribers = [];
        }

        /**
         * Subscribes to the job:* streams for the currently starting job. All
         * handlers ignore events for other jobs and call `finish` on terminal ones.
         *
         * @param {(outcome: object) => void} finish
         * @returns {void}
         */
        #subscribe(finish) {
            const mc = Object.fromEntries(
                ['onJobLog', 'onJobProgress', 'onJobComplete', 'onJobError'].map((name) => [
                    name,
                    (handler) =>
                        globalObject.mcdata[name]((payload) => {
                            const isLog = name === 'onJobLog';
                            if (isLog) {
                                payload = this.#boundedLog(payload);
                            }
                            if (this.#starting) {
                                const bytes = isLog ? (payload.line.length + 1) * 2 : 0;
                                this.#pendingEvents.push({ handler, payload, bytes, isLog });
                                if (isLog) {
                                    this.#earlyLogBytes += bytes;
                                    this.#earlyLogCount++;
                                    while (
                                        this.#earlyLogCount > MAX_PENDING_LINES ||
                                        this.#earlyLogBytes > MAX_PENDING_BYTES
                                    ) {
                                        const index = this.#pendingEvents.findIndex(
                                            (event) => event.isLog,
                                        );
                                        const [removed] = this.#pendingEvents.splice(index, 1);
                                        this.#earlyLogBytes -= removed.bytes;
                                        this.#earlyLogCount--;
                                        this.#droppedOutput = true;
                                    }
                                }
                            } else {
                                handler(payload);
                            }
                        }),
                ]),
            );
            this.#unsubscribers.push(
                mc.onJobLog((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }

                    this.#droppedOutput ||= payload.truncated;
                    this.#appendLog(payload.level, payload.line);
                }),
                mc.onJobProgress((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }
                    const text = describeProgress(payload.event);
                    if (text) {
                        this.#status.textContent = text;
                    }
                    this.#publish();
                    if (typeof payload.event.ratio === 'number') {
                        // Batch progress is not proof of successful job completion.
                        this.#setProgress(Math.min(0.99, payload.event.ratio));
                    } else if (['download', 'upload'].includes(payload.event.phase)) {
                        this.#setProgress(-1);
                    }
                }),
                mc.onJobComplete((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }
                    this.#setProgress(!payload.cancelled && payload.exitCode === 0 ? 1 : 0);
                    if (payload.cancelled) {
                        this.#status.textContent =
                            'Cancelled locally. Already accepted imports may still finish remotely; cancellation is not rollback.';
                        toast(this.#status.textContent, 'warn');
                        finish({ ok: false, cancelled: true });
                        return;
                    }
                    const isSucceeded = payload.exitCode === 0;
                    this.#status.textContent = isSucceeded
                        ? 'Completed successfully.'
                        : `Finished with exit code ${payload.exitCode}.`;
                    toast(
                        isSucceeded ? 'Job completed.' : 'Job finished with errors.',
                        isSucceeded ? 'success' : 'warn',
                    );
                    finish({ ok: isSucceeded, exitCode: payload.exitCode });
                }),
                mc.onJobError((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }
                    this.#setProgress(0);
                    this.#status.textContent = 'Error: ' + payload.message;
                    this.#status.classList.add('error');
                    this.#appendLog('error', payload.message);
                    toast('Job failed: ' + payload.message, 'error', 8000);
                    finish({ ok: false, error: payload.message });
                }),
            );
        }

        /**
         * @returns {HTMLElement} the runner's root node (mount this in a screen)
         */
        get element() {
            return this.#root;
        }

        /**
         * @returns {boolean}
         */
        get isRunning() {
            return this.#starting || this.#jobId !== undefined;
        }

        /**
         * Resets the runner UI to a fresh, idle state.
         *
         * @returns {void}
         */
        reset() {
            if (this.isRunning) {
                return;
            }
            this.#clearLogs();
            this.#setProgress(0);
            this.#status.textContent = 'Idle.';
            this.#cancelButton.setAttribute('disabled', 'true');
        }

        /**
         * Starts a job and wires its lifecycle to the UI. Resolves when the job
         * completes or errors.
         *
         * @param {object} job - structured McdataJob
         * @returns {Promise.<{ ok: boolean, exitCode?: number|null, cancelled?: boolean, error?: string }>}
         */
        async start(job) {
            if (this.isRunning || JobRunner.#activeRunner) {
                return { ok: false, error: 'A job is already running.' };
            }

            JobRunner.#activeRunner = this;
            this.#starting = true;
            this.#pendingEvents = [];
            this.#clearLogs();
            this.#setProgress(-1);
            this.#status.textContent = 'Starting…';
            this.#status.classList.remove('error');
            this.#publish();

            const outcome = new Promise((resolve) => {
                this.#subscribe((result) => {
                    this.#flushLogs();
                    this.#teardown();
                    this.#jobId = undefined;
                    this.#cancelButton.setAttribute('disabled', 'true');
                    this.#release();
                    resolve(result);
                });
            });

            try {
                const result = await globalObject.mcdata.startJob(job);
                this.#jobId = result.jobId;
                this.#starting = false;
                this.#status.textContent = 'Running…';
                this.#publish();
                this.#cancelButton.removeAttribute('disabled');
                const events = this.#pendingEvents;
                this.#pendingEvents = [];
                this.#earlyLogBytes = 0;
                this.#earlyLogCount = 0;
                for (const { handler, payload } of events) {
                    handler(payload);
                }
            } catch (ex) {
                this.#teardown();
                this.#jobId = undefined;
                this.#starting = false;
                this.#pendingEvents = [];
                const error = ex && ex.message ? ex.message : String(ex);
                this.#setProgress(0);
                this.#status.textContent = 'Could not start: ' + error;
                this.#status.classList.add('error');
                this.#cancelButton.setAttribute('disabled', 'true');
                toast(this.#status.textContent, 'error');
                this.#release();
                return { ok: false, error };
            }

            return outcome;
        }

        /**
         * Requests cancellation of the running job (if any), retaining controls until exit.
         *
         * @returns {Promise.<void>}
         */
        async cancel() {
            if (!this.#jobId) {
                return;
            }
            const jobId = this.#jobId;
            this.#cancelButton.setAttribute('disabled', 'true');
            this.#status.textContent =
                'Cancelling locally… Waiting for worker exit. Accepted imports may still finish remotely; cancellation is not rollback.';
            this.#publish();
            try {
                const accepted = await globalObject.mcdata.cancelJob(jobId);
                if (this.#jobId !== jobId) {
                    return;
                }
                this.#status.textContent = accepted
                    ? 'Stop requested; still waiting for worker exit. You can retry Cancel. Accepted imports may still finish remotely; cancellation is not rollback.'
                    : 'Could not stop worker. Retry Cancel; no new transfer can start until it exits.';
            } catch (ex) {
                if (this.#jobId !== jobId) {
                    return;
                }
                this.#status.textContent =
                    'Could not stop worker: ' + (ex?.message ?? String(ex)) + '. Retry Cancel.';
            }
            this.#cancelButton.removeAttribute('disabled');
            this.#publish();
        }
    }

    globalObject.JobRunner = JobRunner;
})(globalThis);
