'use strict';

// Export screen — single-BU and multi-BU Data Extension export. Builds a
// structured McdataJob and hands it to a JobRunner. Uses the shared BU picker
// and DE selector so users choose saved connections/DEs instead of typing raw
// tokens. Exposed as McScreens.export.
(function initExportScreen(globalObject) {
    const { element, toast } = globalObject.McUI;
    const { field, input, select, checkbox, button, directoryPicker } = globalObject.McForms;
    const { JOB_KIND } = globalObject.mcdata;

    /**
     * Parses a textarea of comma/newline separated tokens into a trimmed list.
     *
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

        const sourcesArea = /** @type {HTMLTextAreaElement} */ (element('textarea'));
        sourcesArea.rows = 3;
        sourcesArea.placeholder = 'MyOrg/BU-A\nMyOrg/BU-B';
        const sourcesField = field(
            'Sources (one per line)',
            sourcesArea,
            'multi-BU: --from per line (credential/BU)',
        );
        sourcesField.style.display = 'none';

        const deSelector = new globalObject.McDeSelector({
            getCredBu: () => {
                if (multi.input.checked) {
                    return parseList(sourcesArea.value)[0] ?? '';
                }
                return sourcePicker.getValue();
            },
        });

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

        const maxRows = input({ type: 'number', placeholder: 'e.g. 100000' });
        const maxRowsField = field('Max rows per file', maxRows, 'optional — splits large exports');

        const outputPicker = directoryPicker({ placeholder: 'Defaults to the project folder' });
        const outputField = field('Output folder (project root)', outputPicker.wrap);

        const runButton = button('Start export');
        const controls = element('div', { class: 'form-actions' });
        controls.append(runButton);

        const runner = new globalObject.JobRunner();

        multi.input.addEventListener('change', () => {
            const on = multi.input.checked;
            sourcePicker.element.style.display = on ? 'none' : '';
            sourcesField.style.display = on ? '' : 'none';
        });

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
            const deKeys = deSelector.getKeys();
            const projectRoot = outputPicker.input.value || globalObject.McState.get().projectRoot;

            /** @type {Record<string, unknown>} */
            const job = {
                deKeys,
                format: formatSelect.value,
                jsonPretty: jsonPretty.input.checked,
                git: git.input.checked,
            };
            if (projectRoot) {
                job.projectRoot = projectRoot;
            }
            if (maxRows.value) {
                job.maxRowsPerFile = Number(maxRows.value);
            }

            if (multi.input.checked) {
                const sources = parseList(sourcesArea.value);
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
        optionsRow.append(jsonPretty.wrap, git.wrap);

        root.append(
            multi.wrap,
            sourcePicker.element,
            sourcesField,
            deSelector.element,
            formatRow,
            optionsRow,
            outputField,
            controls,
            runner.element,
        );
        container.append(root);
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.export = { mount };
})(globalThis);
