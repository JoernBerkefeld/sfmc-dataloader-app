'use strict';

// Import screen — single-BU (by DE or by file) and cross-BU import. Uses the
// shared BU picker and DE selector so users choose saved connections/DEs, and
// keeps the destructive safeguards: a typed confirmation before
// clear-before-import and an opt-in backup toggle. Exposed as McScreens.import.
(function initImportScreen(globalObject) {
    const { element, toast } = globalObject.McUI;
    const { field, select, checkbox, button, filePicker } = globalObject.McForms;
    const { JOB_KIND } = globalObject.mcdata;

    /**
     * Confirms only the frozen job displayed in a native, keyboard-modal dialog.
     *
     * @param {object} job
     * @returns {Promise.<boolean>}
     */
    function confirmClear(job) {
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            const dialog = /** @type {HTMLDialogElement} */ (
                element('dialog', {
                    class: 'modal',
                    attrs: {
                        'aria-labelledby': 'clear-title',
                        'aria-describedby': 'clear-targets',
                    },
                })
            );
            const expected = job.deKeys ? job.deKeys.join(', ') : 'CLEAR';
            const summary = [
                'Target Business Unit(s): ' + (job.to || [job.source]).join(', '),
                job.from ? 'Source Business Unit: ' + job.from : '',
                job.deKeys ? 'DE key(s): ' + expected : 'Files: ' + job.filePaths.join(', '),
            ]
                .filter(Boolean)
                .join('\n');
            const input = /** @type {HTMLInputElement} */ (
                element('input', { attrs: { id: 'clear-answer', autocomplete: 'off' } })
            );
            const form = element('form', { class: 'confirmation-form' });
            const cancel = button('Cancel', { variant: 'btn-secondary' });
            const authorize = button('Clear and import');
            cancel.type = 'button';
            authorize.type = 'submit';
            authorize.disabled = true;
            const isMatch = () => expected.trim().length > 0 && input.value === expected;
            input.addEventListener('input', () => {
                authorize.disabled = !isMatch();
            });
            const actions = element('div', { class: 'modal-actions' });
            actions.append(cancel, authorize);
            form.append(
                element('label', {
                    text: 'Type exactly to confirm: ' + expected,
                    attrs: { for: 'clear-answer' },
                }),
                input,
                actions,
            );
            dialog.append(
                element('h2', {
                    text: 'Clear all rows before import?',
                    attrs: { id: 'clear-title' },
                }),
                element('p', {
                    text: 'This will DELETE ALL ROWS in the target Data Extension(s).',
                }),
                element('pre', { text: summary, attrs: { id: 'clear-targets' } }),
                form,
            );
            let isAuthorized = false;
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                if (isMatch()) {
                    isAuthorized = true;
                    dialog.close();
                }
            });
            cancel.addEventListener('click', () => dialog.close());
            dialog.addEventListener('cancel', () => {
                isAuthorized = false;
            });
            dialog.addEventListener(
                'close',
                () => {
                    dialog.remove();
                    if (previousFocus?.isConnected) {
                        previousFocus.focus();
                    }
                    resolve(isAuthorized);
                },
                { once: true },
            );
            document.body.append(dialog);
            dialog.showModal();
            input.focus();
        });
    }

    /**
     * @param {HTMLElement} container
     * @returns {void}
     */
    function mount(container) {
        const root = element('div', { class: 'screen' });
        root.append(element('h2', { text: 'Import Data' }));

        const modeSelect = select(
            [
                { value: 'singleDe', label: 'Single BU — from Data Extension export files' },
                { value: 'singleFile', label: 'Single BU — from specific files' },
                { value: 'crossApi', label: 'Cross-BU — copy DE from source to targets (API)' },
                { value: 'crossFile', label: 'Cross-BU — import files into targets' },
            ],
            'singleDe',
        );
        const modeField = field('Import type', modeSelect);

        const targetPicker = new globalObject.McBuPicker({
            label: 'Target Business Unit',
            hint: 'single-BU target (credential/BU)',
        });

        const targetsPicker = new globalObject.McBuPicker({
            label: 'Target Business Units',
            multiple: true,
            hint: 'Select across saved credentials or enter tokens manually.',
        });
        const targetsField = targetsPicker.element;

        const fromPicker = new globalObject.McBuPicker({
            label: 'Source Business Unit',
            hint: 'cross-BU API source (credential/BU)',
        });

        const deSelector = new globalObject.McDeSelector({
            getContext: () => modeSelect.value,
            getCredBu: () =>
                modeSelect.value === 'crossApi' ? fromPicker.getValue() : targetPicker.getValue(),
        });

        targetPicker.onChange(() => deSelector.invalidate());
        fromPicker.onChange(() => deSelector.invalidate());
        const files = filePicker({ extensions: ['csv', 'tsv', 'json'] });
        const filesField = field('Files to import', files.wrap);

        const writeMode = select(
            [
                { value: 'upsert', label: 'Upsert (update or insert)' },
                { value: 'insert', label: 'Insert only' },
            ],
            'upsert',
        );
        const writeModeField = field('Write mode', writeMode);

        const backup = checkbox('Backup Data Extension before import', true);
        const clear = checkbox('Clear all rows before import (destructive)', false);
        const skipEmptyLines = checkbox('Skip empty lines (CSV/TSV)', true);
        const debug = checkbox('Debug logs (may contain sensitive API data)', false);
        let defaultsRevision = 0;
        for (const control of [writeMode, backup.input, skipEmptyLines.input, debug.input]) {
            control.addEventListener('change', () => defaultsRevision++);
        }
        globalObject.McScreens.import.activate = async () => {
            void targetPicker.refresh();
            void targetsPicker.refresh();
            void fromPicker.refresh();
            const revision = defaultsRevision;
            try {
                const settings = await globalObject.mcdata.getSettings();
                if (
                    revision === defaultsRevision &&
                    !isSubmitting &&
                    !runner.isRunning &&
                    settings?.transferDefaults
                ) {
                    const defaults = settings.transferDefaults;
                    writeMode.value = defaults.mode;
                    backup.input.checked = defaults.backupBeforeImport;
                    skipEmptyLines.input.checked = defaults.skipEmptyLines;
                    debug.input.checked = defaults.debug;
                }
            } catch {
                toast(
                    'Could not load transfer defaults; current run options are unchanged.',
                    'warn',
                );
            }
        };

        let isSubmitting = false;
        let hasActiveJob = false;
        const runButton = button('Start import');
        const updateRunButton = () => {
            runButton.disabled = isSubmitting || hasActiveJob;
        };
        globalObject.JobRunner.subscribeActive((active) => {
            hasActiveJob = Boolean(active);
            updateRunButton();
        });
        const controls = element('div', { class: 'form-actions' });
        controls.append(runButton);

        const runner = new globalObject.JobRunner({ view: 'import', label: 'Import' });

        /**
         * For file-based imports, warns before starting when any selected file is
         * at least 1 GiB. API-based imports (no filePaths) never trigger this.
         * Acknowledging the advisory does not authorize or cancel the job.
         *
         * @param {object} job
         * @returns {void}
         */
        function warnLargeFiles(job) {
            if (!Array.isArray(job.filePaths) || job.filePaths.length === 0) {
                return;
            }
            const message = globalObject.McFileSize.buildLargeFileWarning(files.getSizedFiles());
            if (message) {
                globalObject.alert(message);
            }
        }

        /**
         * Toggles field visibility to match the selected import type.
         *
         * @returns {void}
         */
        function applyMode() {
            const mode = modeSelect.value;
            const isCross = mode === 'crossApi' || mode === 'crossFile';
            const isUsesFiles = mode === 'singleFile' || mode === 'crossFile';
            const isUsesDe = mode === 'singleDe' || mode === 'crossApi';

            targetPicker.element.style.display = isCross ? 'none' : '';
            targetsField.style.display = isCross ? '' : 'none';
            fromPicker.element.style.display = mode === 'crossApi' ? '' : 'none';
            deSelector.element.style.display = isUsesDe ? '' : 'none';
            filesField.style.display = isUsesFiles ? '' : 'none';
            skipEmptyLines.wrap.style.display = mode === 'crossApi' ? 'none' : '';
        }
        modeSelect.addEventListener('change', () => {
            deSelector.invalidate();
            applyMode();
        });

        runButton.addEventListener('click', async () => {
            if (isSubmitting || hasActiveJob || runner.isRunning) {
                return;
            }
            defaultsRevision++;
            isSubmitting = true;
            updateRunButton();
            let shouldRestoreFocus = false;
            try {
                let job;
                try {
                    job = buildJob();
                    for (const value of Object.values(job)) {
                        if (Array.isArray(value)) {
                            Object.freeze(value);
                        }
                    }
                    Object.freeze(job);
                } catch (ex) {
                    toast(ex && ex.message ? ex.message : String(ex), 'error');
                    return;
                }
                if (job.clearBeforeImport && !(await confirmClear(job))) {
                    shouldRestoreFocus = true;
                    toast('Clear-before-import cancelled — confirmation did not match.', 'warn');
                    return;
                }
                warnLargeFiles(job);
                await runner.start(job);
            } finally {
                isSubmitting = false;
                updateRunButton();
                if (shouldRestoreFocus && !runButton.disabled) {
                    runButton.focus();
                }
            }
        });

        /**
         * @returns {object} structured McdataJob
         */
        function buildJob() {
            const mode = modeSelect.value;
            const projectRoot = globalObject.McState.get().projectRoot;
            /**
             * @type {Record<string, unknown>}
             */
            const job = {
                mode: writeMode.value,
                debug: debug.input.checked,
                backupBeforeImport: backup.input.checked,
                clearBeforeImport: clear.input.checked,
                skipEmptyLines: mode !== 'crossApi' && skipEmptyLines.input.checked,
            };
            if (projectRoot) {
                job.projectRoot = projectRoot;
            }

            const selectedFiles = [...files.getFiles()];

            if (mode === 'singleDe' || mode === 'singleFile') {
                const target = targetPicker.getValue();
                if (!target) {
                    throw new Error('Choose a target credential/BU.');
                }
                job.kind = JOB_KIND.IMPORT;
                job.source = target;
                if (mode === 'singleDe') {
                    job.deKeys = [...deSelector.getKeys()];
                } else {
                    if (selectedFiles.length === 0) {
                        throw new Error('Select at least one file to import.');
                    }
                    job.filePaths = selectedFiles;
                }
                return job;
            }

            // cross-BU
            const targets = targetsPicker.getValues();
            if (targets.length === 0) {
                throw new Error('Enter at least one target BU.');
            }
            job.kind = JOB_KIND.IMPORT_CROSS_BU;
            job.to = targets;
            if (mode === 'crossApi') {
                const from = fromPicker.getValue();
                if (!from) {
                    throw new Error('Choose a source credential/BU.');
                }
                job.from = from;
                job.deKeys = [...deSelector.getKeys()];
            } else {
                if (selectedFiles.length === 0) {
                    throw new Error('Select at least one file to import.');
                }
                job.filePaths = selectedFiles;
            }
            return job;
        }

        root.append(
            element('p', {
                class: 'muted',
                text: 'Skip empty lines includes blank, delimiter-only and quoted-empty records. Automatic empty right/bottom file-edge cleanup remains enabled when unchecked.',
            }),
        );
        const optionsRow = element('div', { class: 'form-row' });
        optionsRow.append(backup.wrap, clear.wrap, skipEmptyLines.wrap, debug.wrap);

        root.append(
            modeField,
            fromPicker.element,
            targetPicker.element,
            targetsField,
            deSelector.element,
            filesField,
            writeModeField,
            optionsRow,
            controls,
            runner.element,
        );
        container.append(root);
        applyMode();
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.import = { mount };
})(globalThis);
