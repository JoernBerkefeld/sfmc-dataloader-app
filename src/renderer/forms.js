'use strict';

// Form-building helpers shared by the screens. Exposed on the global `McForms`.
// These only build DOM + read values; no privileged calls happen here.
(function initForms(globalObject) {
    const { element } = globalObject.McUI;

    /**
     * Builds a labelled field wrapper around a control.
     *
     * @param {string} label
     * @param {HTMLElement} control
     * @param {string} [hint]
     * @returns {HTMLElement}
     */
    function field(label, control, hint) {
        const wrap = element('label', { class: 'field' });
        wrap.append(element('span', { class: 'field-label', text: label }));
        wrap.append(control);
        if (hint) {
            wrap.append(element('span', { class: 'field-hint muted', text: hint }));
        }
        return wrap;
    }

    /**
     * @param {{ id?: string, value?: string, placeholder?: string, type?: string }} [options]
     * @returns {HTMLInputElement}
     */
    function input(options) {
        const node = /** @type {HTMLInputElement} */ (element('input'));
        node.type = (options && options.type) || 'text';
        if (options && options.id) {
            node.id = options.id;
        }
        if (options && typeof options.value === 'string') {
            node.value = options.value;
        }
        if (options && options.placeholder) {
            node.placeholder = options.placeholder;
        }
        return node;
    }

    /**
     * @param {{value: string, label: string}[]} items
     * @param {string} [selected]
     * @returns {HTMLSelectElement}
     */
    function select(items, selected) {
        const node = /** @type {HTMLSelectElement} */ (element('select'));
        for (const item of items) {
            const option = /** @type {HTMLOptionElement} */ (
                element('option', { text: item.label })
            );
            option.value = item.value;
            if (item.value === selected) {
                option.selected = true;
            }
            node.append(option);
        }
        return node;
    }

    /**
     * @param {string} label
     * @param {boolean} [checked]
     * @returns {{ wrap: HTMLElement, input: HTMLInputElement }}
     */
    function checkbox(label, checked) {
        const box = /** @type {HTMLInputElement} */ (element('input'));
        box.type = 'checkbox';
        box.checked = Boolean(checked);
        const wrap = element('label', { class: 'checkbox' });
        wrap.append(box, element('span', { text: label }));
        return { wrap, input: box };
    }

    /**
     * @param {string} text
     * @param {{ variant?: string, type?: string }} [options]
     * @returns {HTMLButtonElement}
     */
    function button(text, options) {
        const node = /** @type {HTMLButtonElement} */ (element('button', { text }));
        node.type = (options && options.type) || 'button';
        node.className = 'btn ' + ((options && options.variant) || 'btn-primary');
        return node;
    }

    /**
     * A directory picker: read-only input + Browse button bound to window.mcdata.
     *
     * @param {{ placeholder?: string }} [options]
     * @returns {{ wrap: HTMLElement, input: HTMLInputElement }}
     */
    function directoryPicker(options) {
        const text = input({ placeholder: (options && options.placeholder) || 'Choose a folder…' });
        text.readOnly = true;
        text.setAttribute('aria-label', 'Selected folder');
        const browse = button('Browse…', { variant: 'btn-secondary' });
        browse.setAttribute('aria-label', 'Browse for folder');
        browse.addEventListener('click', async () => {
            const chosen = await globalObject.mcdata.chooseDirectory();
            if (chosen) {
                text.value = chosen;
                text.dispatchEvent(new Event('change'));
            }
        });
        const wrap = element('div', { class: 'picker' });
        wrap.append(text, browse);
        return { wrap, input: text };
    }

    /**
     * A multi-file picker: read-only input listing count + total size, a Browse
     * button, and a hint line that turns into a warning for multi-GB selections.
     * Sizes come from the main process (see DIALOG_OPEN_FILES).
     *
     * @param {{ extensions?: string[] }} [options]
     * @returns {{
     *   wrap: HTMLElement,
     *   getFiles: () => string[],
     *   getSizedFiles: () => { path: string, size: number }[],
     * }}
     */
    function filePicker(options) {
        const fileSize = globalObject.McFileSize;
        /**
         * @type {{ path: string, size: number }[]}
         */
        let files = [];
        const text = input({ placeholder: 'No files selected' });
        text.readOnly = true;
        text.setAttribute('aria-label', 'Selected import files');
        const browse = button('Browse…', { variant: 'btn-secondary' });
        browse.setAttribute('aria-label', 'Browse for import files');
        const note = element('span', { class: 'field-hint muted' });
        const selectedFiles = element('ul', { class: 'selected-files' });
        const clearFiles = button('Clear files', { variant: 'btn-secondary' });
        clearFiles.disabled = true;
        const renderFiles = () => {
            selectedFiles.replaceChildren();
            for (const [index, file] of files.entries()) {
                const item = element('li', {
                    text: `${file.path} (${fileSize.formatBytes(file.size)})`,
                });
                const remove = button('Remove', { variant: 'btn-secondary' });
                remove.setAttribute('aria-label', `Remove ${file.path}`);
                remove.addEventListener('click', () => {
                    files = files.filter((_file, position) => position !== index);
                    renderFiles();
                });
                item.append(remove);
                selectedFiles.append(item);
            }
            const summary = fileSize.summarizeFiles(files);
            text.value = '';
            if (files.length > 0) {
                text.value =
                    files.length === 1
                        ? `${files[0].path}  (${fileSize.formatBytes(files[0].size)})`
                        : `${files.length} files selected  (${summary.totalText} total)`;
            }
            note.textContent = summary.hasLargeFile
                ? `Large import — largest file ${fileSize.formatBytes(summary.largestBytes)}. ` +
                  'It will stream in batches; keep the app open until it finishes.'
                : '';
            note.classList.toggle('warn', summary.hasLargeFile);
            clearFiles.disabled = files.length === 0;
        };
        clearFiles.addEventListener('click', () => {
            files = [];
            renderFiles();
        });
        browse.addEventListener('click', async () => {
            const chosen = await globalObject.mcdata.chooseFiles(options || {});
            if (chosen && chosen.length > 0) {
                files = chosen.map((file) => ({ ...file }));
                renderFiles();
            }
        });
        const row = element('div', { class: 'picker' });
        row.append(text, browse, clearFiles);
        const wrap = element('div', { class: 'file-picker' });
        wrap.append(row, selectedFiles, note);
        return {
            wrap,
            getFiles: () => files.map((file) => file.path),
            getSizedFiles: () => [...files],
        };
    }

    globalObject.McForms = {
        field,
        input,
        select,
        checkbox,
        button,
        directoryPicker,
        filePicker,
    };
})(globalThis);
