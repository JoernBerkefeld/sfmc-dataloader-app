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
     * @param {string} raw
     * @returns {string[]}
     */
    function parseList(raw) {
        return raw
            .split(/[\n,]+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
    }

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

        const targetsArea = /** @type {HTMLTextAreaElement} */ (element('textarea'));
        targetsArea.rows = 3;
        targetsArea.placeholder = 'MyOrg/BU-A\nMyOrg/BU-B';
        const targetsField = field(
            'Targets (one per line)',
            targetsArea,
            'cross-BU: --to per line (credential/BU)',
        );

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
        globalObject.McScreens.import.activate = () => {
            void targetPicker.refresh();
            void fromPicker.refresh();
        };

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
        const skipEmptyLines = checkbox('Skip empty lines (CSV/TSV)', false);

        const runButton = button('Start import');
        const controls = element('div', { class: 'form-actions' });
        controls.append(runButton);

        const runner = new globalObject.JobRunner();

        /**
         * For file-based imports, warns before starting when any selected file is
         * very large (multi-GB). API-based imports (no filePaths) never trigger
         * this. Returns true to proceed, false to abort.
         *
         * @param {object} job
         * @returns {boolean}
         */
        function confirmLargeFiles(job) {
            if (!Array.isArray(job.filePaths) || job.filePaths.length === 0) {
                return true;
            }
            const message = globalObject.McFileSize.buildLargeFileWarning(files.getSizedFiles());
            if (!message) {
                return true;
            }
            return globalObject.confirm(message);
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

        let isSubmitting = false;
        runButton.addEventListener('click', async () => {
            if (isSubmitting || runner.isRunning) {
                return;
            }
            isSubmitting = true;
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
                    toast('Clear-before-import cancelled — confirmation did not match.', 'warn');
                    return;
                }
                if (!confirmLargeFiles(job)) {
                    toast('Import cancelled.', 'warn');
                    return;
                }
                runButton.setAttribute('disabled', 'true');
                await runner.start(job);
            } finally {
                isSubmitting = false;
                runButton.removeAttribute('disabled');
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
            const targets = parseList(targetsArea.value);
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

        const optionsRow = element('div', { class: 'form-row' });
        optionsRow.append(backup.wrap, clear.wrap, skipEmptyLines.wrap);

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
