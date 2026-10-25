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

    class JobRunner {
        /**
         * @type {string | undefined}
         */
        #jobId = undefined;
        #starting = false;
        #pendingEvents = [];
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

        constructor() {
            this.#root = this.#build();
        }

        /**
         * Builds the runner DOM once.
         *
         * @returns {HTMLElement}
         */
        #build() {
            const root = element('div', { class: 'job-runner' });

            const bar = element('div', { class: 'progress' });
            this.#fill = element('div', { class: 'progress-fill' });
            bar.append(this.#fill);

            this.#status = element('p', { class: 'job-status muted', text: 'Idle.' });

            this.#log = element('pre', { class: 'job-log', attrs: { 'aria-live': 'polite' } });

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

            root.append(bar, this.#status, controls, this.#log);
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
                this.#fill.classList.add('indeterminate');
                this.#fill.style.width = '40%';
                return;
            }
            this.#fill.classList.remove('indeterminate');
            const clamped = Math.max(0, Math.min(1, ratio));
            this.#fill.style.width = Math.round(clamped * 100) + '%';
        }

        /**
         * Appends a line to the log panel and keeps it scrolled to the bottom.
         *
         * @param {string} level - info|warn|error
         * @param {string} line
         * @returns {void}
         */
        #appendLog(level, line) {
            const entry = element('span', { class: 'log-line log-' + level, text: line + '\n' });
            this.#log.append(entry);
            this.#log.scrollTop = this.#log.scrollHeight;
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
                            if (this.#starting) {
                                this.#pendingEvents.push(() => handler(payload));
                            } else {
                                handler(payload);
                            }
                        }),
                ]),
            );
            this.#unsubscribers.push(
                mc.onJobLog((payload) => {
                    if (payload.jobId === this.#jobId) {
                        this.#appendLog(payload.level, payload.line);
                    }
                }),
                mc.onJobProgress((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }
                    const text = describeProgress(payload.event);
                    if (text) {
                        this.#status.textContent = text;
                    }
                    if (typeof payload.event.ratio === 'number') {
                        this.#setProgress(payload.event.ratio);
                    } else if (['download', 'upload'].includes(payload.event.phase)) {
                        this.#setProgress(-1);
                    }
                }),
                mc.onJobComplete((payload) => {
                    if (payload.jobId !== this.#jobId) {
                        return;
                    }
                    this.#setProgress(1);
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
            clear(this.#log);
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
            if (this.isRunning) {
                return { ok: false, error: 'A job is already running.' };
            }

            this.#starting = true;
            this.#pendingEvents = [];
            clear(this.#log);
            this.#setProgress(-1);
            this.#status.textContent = 'Starting…';
            this.#status.classList.remove('error');

            const outcome = new Promise((resolve) => {
                this.#subscribe((result) => {
                    this.#teardown();
                    this.#jobId = undefined;
                    this.#cancelButton.setAttribute('disabled', 'true');
                    resolve(result);
                });
            });

            try {
                const result = await globalObject.mcdata.startJob(job);
                this.#jobId = result.jobId;
                this.#starting = false;
                this.#status.textContent = 'Running…';
                this.#cancelButton.removeAttribute('disabled');
                const events = this.#pendingEvents;
                this.#pendingEvents = [];
                for (const deliver of events) {
                    deliver();
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
        }
    }

    globalObject.JobRunner = JobRunner;
})(globalThis);
