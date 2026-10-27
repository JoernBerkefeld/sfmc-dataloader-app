'use strict';

// Export screen — single-BU and multi-BU Data Extension export. Builds a
// structured McdataJob and hands it to a JobRunner. Uses the shared BU picker
// and DE selector so users choose saved connections/DEs instead of typing raw
// tokens. Exposed as McScreens.export.
(function initExportScreen(globalObject) {
    const { element, toast } = globalObject.McUI;
    const { field, input, select, checkbox, button } = globalObject.McForms;
    const { JOB_KIND } = globalObject.mcdata;

    /**
     * Mounts the export screen into the given container.
     *
     * @param {HTMLElement} container
     * @returns {void}
     */
    function mount(container) {
        const root = element('div', { class: 'screen' });
        root.append(element('h2', { text: 'Export Data Extensions' }));

        const multi = checkbox('Export from multiple Business Units (multi-BU)', false);

        const sourcePicker = new globalObject.McBuPicker({
            label: 'Source Business Unit',
            hint: 'the credential/BU to export from',
        });

        const sourcesPicker = new globalObject.McBuPicker({
            label: 'Source Business Units',
            multiple: true,
            hint: 'Select across saved credentials or enter tokens manually.',
        });
        const sourcesField = element('div');
        const listSource = element('p', { class: 'muted' });
        sourcesField.append(sourcesPicker.element, listSource);
        sourcesField.style.display = 'none';

        const projectInfo = element('p', { class: 'field-hint muted' });
        const updateProjectInfo = () => {
            const projectRoot = globalObject.McState.get().projectRoot;
            projectInfo.textContent = projectRoot
                ? `Export project: ${projectRoot}. Output uses this selected project.`
                : 'No project selected. Choose a project in Connections before exporting.';
        };
        globalObject.McState.subscribe(updateProjectInfo);
        updateProjectInfo();
        const deSelector = new globalObject.McDeSelector({
            getProjectRoot: () => globalObject.McState.get().projectRoot,
            getContext: () => JSON.stringify([multi.input.checked, sourcesPicker.getValues()]),
            getCredBu: () => {
                if (multi.input.checked) {
                    return sourcesPicker.getValues()[0] ?? '';
                }
                return sourcePicker.getValue();
            },
        });

        sourcePicker.onChange(() => deSelector.invalidate());
        const updateListSource = () => {
            const first = sourcesPicker.getValue();
            listSource.textContent = first
                ? `DE list source: ${first} (first source BU). Other source BUs have not been validated.`
                : 'The first selected source BU supplies the DE list. Other source BUs are not validated by this list.';
        };
        sourcesPicker.onChange(() => {
            deSelector.invalidate();
            updateListSource();
        });
        updateListSource();
        const formatSelect = select(
            [
                { value: 'csv', label: 'CSV' },
                { value: 'tsv', label: 'TSV' },
                { value: 'json', label: 'JSON' },
            ],
            'csv',
        );
        const formatField = field('Format', formatSelect);

        const jsonPretty = checkbox('Pretty-print JSON', false);
        const git = checkbox('Stable filenames for git (--git)', false);
        const debug = checkbox('Debug logs (may contain sensitive API data)', false);
        let defaultsRevision = 0;
        for (const control of [formatSelect, git.input, debug.input]) {
            control.addEventListener('change', () => defaultsRevision++);
        }
        globalObject.McScreens.export.activate = async () => {
            void sourcePicker.refresh();
            void sourcesPicker.refresh();
            const revision = defaultsRevision;
            try {
                const settings = await globalObject.mcdata.getSettings();
                if (
                    revision === defaultsRevision &&
                    !runner.isRunning &&
                    settings?.transferDefaults
                ) {
                    const defaults = settings.transferDefaults;
                    formatSelect.value = defaults.format;
                    git.input.checked = defaults.git;
                    debug.input.checked = defaults.debug;
                }
            } catch {
                toast(
                    'Could not load transfer defaults; current run options are unchanged.',
                    'warn',
                );
            }
        };

        const maxRows = input({ type: 'number', placeholder: 'e.g. 100000' });
        maxRows.min = '1';
        maxRows.step = '1';
        const maxRowsField = field('Max rows per file', maxRows, 'optional — splits large exports');
        const maxRowsError = element('span', {
            attrs: { id: 'export-max-rows-error' },
            class: 'field-hint warn',
        });
        maxRowsError.setAttribute('aria-live', 'polite');
        maxRows.setAttribute('aria-describedby', 'export-max-rows-error');
        maxRowsField.append(maxRowsError);
        const validateMaxRows = () => {
            const value = maxRows.value.trim();
            const isValid =
                !maxRows.validity?.badInput &&
                (value === '' || (Number.isSafeInteger(Number(value)) && Number(value) > 0));
            maxRowsError.textContent = isValid
                ? ''
                : 'Enter a positive whole number, or leave blank.';
            maxRows.setAttribute('aria-invalid', String(!isValid));
            return isValid;
        };
        maxRows.addEventListener('input', validateMaxRows);
        maxRows.addEventListener('change', validateMaxRows);

        let isSubmitting = false;
        let hasActiveJob = false;
        const runButton = button('Start export');
        const updateRunButton = () => {
            runButton.disabled = isSubmitting || hasActiveJob;
        };
        globalObject.JobRunner.subscribeActive((active) => {
            hasActiveJob = Boolean(active);
            updateRunButton();
        });
        const controls = element('div', { class: 'form-actions' });
        controls.append(runButton);

        const runner = new globalObject.JobRunner({ view: 'export', label: 'Export' });

        multi.input.addEventListener('change', () => {
            deSelector.invalidate();
            const on = multi.input.checked;
            sourcePicker.element.style.display = on ? 'none' : '';
            sourcesField.style.display = on ? '' : 'none';
        });

        runButton.addEventListener('click', async () => {
            if (isSubmitting || hasActiveJob || runner.isRunning) {
                return;
            }
            defaultsRevision++;
            if (!validateMaxRows()) {
                maxRows.focus();
                return;
            }
            let job;
            try {
                job = buildJob();
            } catch (ex) {
                toast(ex && ex.message ? ex.message : String(ex), 'error');
                return;
            }
            isSubmitting = true;
            updateRunButton();
            try {
                await runner.start(job);
            } finally {
                isSubmitting = false;
                updateRunButton();
            }
        });

        /**
         * @returns {object} structured McdataJob
         */
        function buildJob() {
            const deKeys = deSelector.getKeys();
            const projectRoot = globalObject.McState.get().projectRoot;
            if (!projectRoot) {
                throw new Error('Choose a project in Connections before exporting.');
            }

            /**
             * @type {Record<string, unknown>}
             */
            const job = {
                deKeys,
                format: formatSelect.value,
                jsonPretty: jsonPretty.input.checked,
                git: git.input.checked,
                debug: debug.input.checked,
            };
            if (projectRoot) {
                job.projectRoot = projectRoot;
            }
            if (maxRows.value.trim()) {
                job.maxRowsPerFile = Number(maxRows.value);
            }

            if (multi.input.checked) {
                const sources = sourcesPicker.getValues();
                if (sources.length === 0) {
                    throw new Error('Enter at least one source BU.');
                }
                job.kind = JOB_KIND.EXPORT_MULTI_BU;
                job.sources = sources;
            } else {
                const source = sourcePicker.getValue();
                if (!source) {
                    throw new Error('Choose a source credential/BU.');
                }
                job.kind = JOB_KIND.EXPORT;
                job.source = source;
            }
            return job;
        }

        const formatRow = element('div', { class: 'form-row' });
        formatRow.append(formatField, maxRowsField);

        const optionsRow = element('div', { class: 'form-row' });
        optionsRow.append(jsonPretty.wrap, git.wrap, debug.wrap);

        root.append(
            multi.wrap,
            sourcePicker.element,
            sourcesField,
            deSelector.element,
            formatRow,
            optionsRow,
            projectInfo,
            controls,
            runner.element,
        );
        container.append(root);
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.export = { mount };
})(globalThis);
