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
     * Requires the user to type the exact DE key(s) to unlock a clear-before-import.
     * Returns true only when the confirmation text matches.
     *
     * @param {string[]} deKeys
     * @returns {boolean}
     */
    function confirmClear(deKeys) {
        const expected = deKeys.join(', ');
        const answer = globalObject.prompt(
            'This will DELETE ALL ROWS in the target Data Extension(s) before import.\n\n' +
                'Type the target key(s) exactly to confirm:\n' +
                expected,
        );
        return answer !== null && answer.trim() === expected;
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
            getCredBu: () =>
                modeSelect.value === 'crossApi' ? fromPicker.getValue() : targetPicker.getValue(),
        });

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
        }
        modeSelect.addEventListener('change', applyMode);

        runButton.addEventListener('click', async () => {
            if (runner.isRunning) {
                return;
            }
            let job;
            try {
                job = buildJob();
            } catch (ex) {
                toast(ex && ex.message ? ex.message : String(ex), 'error');
                return;
            }
            if (job.clearBeforeImport && !confirmClear(job.deKeys || [])) {
                toast('Clear-before-import cancelled — confirmation did not match.', 'warn');
                return;
            }
            if (!confirmLargeFiles(job)) {
                toast('Import cancelled.', 'warn');
                return;
            }
            runButton.setAttribute('disabled', 'true');
            try {
                await runner.start(job);
            } finally {
                runButton.removeAttribute('disabled');
            }
        });

        /**
         * @returns {object} structured McdataJob
         */
        function buildJob() {
            const mode = modeSelect.value;
            const projectRoot = globalObject.McState.get().projectRoot;
            /** @type {Record<string, unknown>} */
            const job = {
                mode: writeMode.value,
                backupBeforeImport: backup.input.checked,
                clearBeforeImport: clear.input.checked,
            };
            if (projectRoot) {
                job.projectRoot = projectRoot;
            }

            const selectedFiles = files.getFiles();

            if (mode === 'singleDe' || mode === 'singleFile') {
                const target = targetPicker.getValue();
                if (!target) {
                    throw new Error('Choose a target credential/BU.');
                }
                job.kind = JOB_KIND.IMPORT;
                job.source = target;
                if (mode === 'singleDe') {
                    job.deKeys = deSelector.getKeys();
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
                job.deKeys = deSelector.getKeys();
            } else {
                if (selectedFiles.length === 0) {
                    throw new Error('Select at least one file to import.');
                }
                job.filePaths = selectedFiles;
            }
            return job;
        }

        const optionsRow = element('div', { class: 'form-row' });
        optionsRow.append(backup.wrap, clear.wrap);

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
