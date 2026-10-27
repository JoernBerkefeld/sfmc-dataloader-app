'use strict';

// A reusable "pick Data Extensions" control shared by the Export and Import
// screens. It offers two modes:
//   • List  — load the BU's live DE list and check the ones you want;
//   • Manual — type customer keys (comma/newline separated) for advanced users.
// The caller supplies a getter for the current `credential/BU` token so the
// same control works whether the BU comes from a dropdown or a text field.
// Exposed as the global `McDeSelector`.
(function initDeSelector(globalObject) {
    const { element, toast } = globalObject.McUI;
    const { field, button } = globalObject.McForms;

    /**
     * @param {string} raw
     * @returns {string[]}
     */
    function parseKeys(raw) {
        return raw
            .split(/[\n,]+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
    }

    class DeSelector {
        /**
         * @type {() => string}
         */
        #getCredBu;
        #getContext;
        #getProjectRoot;
        #request = 0;
        #provenance;
        #unsubscribe;
        #search;
        #selectionStatus;
        #loading = false;
        #rows = [];
        /**
         * @type {HTMLElement}
         */
        #root;
        /**
         * @type {HTMLSelectElement}
         */
        #modeSelect;
        /**
         * @type {HTMLElement}
         */
        #listWrap;
        /**
         * @type {HTMLElement}
         */
        #checkList;
        /**
         * @type {HTMLElement}
         */
        #listStatus;
        /**
         * @type {HTMLTextAreaElement}
         */
        #manualArea;
        /**
         * @type {HTMLElement}
         */
        #manualWrap;

        /**
         * @param {{ getCredBu: () => string, getContext?: () => string, getProjectRoot?: () => string }} options
         */
        constructor(options) {
            this.#getCredBu = options.getCredBu;
            this.#getContext = options.getContext ?? (() => '');
            this.#getProjectRoot =
                options.getProjectRoot ?? (() => globalObject.McState.get().projectRoot);
            this.#root = this.#build();
            this.#unsubscribe = globalObject.McState.subscribe(() => this.invalidate());
        }

        /**
         * @returns {HTMLElement}
         */
        #build() {
            const root = element('div', { class: 'de-selector' });

            this.#modeSelect = /** @type {HTMLSelectElement} */ (element('select'));
            for (const opt of [
                { value: 'list', label: 'Pick from the DE list' },
                { value: 'manual', label: 'Enter keys manually' },
            ]) {
                const node = /** @type {HTMLOptionElement} */ (
                    element('option', { text: opt.label })
                );
                node.value = opt.value;
                this.#modeSelect.append(node);
            }
            const modeField = field('Data Extensions', this.#modeSelect);

            // list mode
            const loadButton = button('Load / refresh DE list', { variant: 'btn-secondary' });
            loadButton.addEventListener('click', () => this.#loadList());
            this.#listStatus = element('p', {
                class: 'muted',
                text: 'Load the list to choose DEs.',
            });
            this.#checkList = element('div', { class: 'de-checklist' });
            this.#listWrap = element('div', { class: 'de-list-mode' });
            const listActions = element('div', { class: 'form-actions' });
            const selectVisible = button('Select visible', { variant: 'btn-secondary' });
            const clearSelection = button('Clear selection', { variant: 'btn-secondary' });
            selectVisible.addEventListener('click', () => this.#setSelection(true));
            clearSelection.addEventListener('click', () => this.#setSelection(false));
            listActions.append(loadButton, selectVisible, clearSelection);
            this.#search = /** @type {HTMLInputElement} */ (element('input'));
            this.#search.type = 'search';
            this.#search.placeholder = 'Search by name or key';
            this.#search.addEventListener('input', () => this.#updateSelection());
            this.#selectionStatus = element('p', { class: 'muted' });
            this.#selectionStatus.setAttribute('aria-live', 'polite');
            this.#listWrap.append(
                listActions,
                field('Search Data Extensions', this.#search),
                this.#listStatus,
                this.#selectionStatus,
                this.#checkList,
            );
            this.#updateSelection();

            // manual mode
            this.#manualArea = /** @type {HTMLTextAreaElement} */ (element('textarea'));
            this.#manualArea.rows = 3;
            this.#manualArea.placeholder = 'DE_External_Key_1\nDE_External_Key_2';
            this.#manualWrap = field(
                'Keys (one per line)',
                this.#manualArea,
                'comma or newline separated',
            );
            this.#manualWrap.style.display = 'none';

            this.#modeSelect.addEventListener('change', () => this.#applyMode());

            root.append(modeField, this.#listWrap, this.#manualWrap);
            return root;
        }

        /**
         * @returns {void}
         */
        #applyMode() {
            const isManual = this.#modeSelect.value === 'manual';
            this.#manualWrap.style.display = isManual ? '' : 'none';
            this.#listWrap.style.display = isManual ? 'none' : '';
        }

        /**
         * Loads the DE list for the current BU and renders a checkbox per DE.
         *
         * @returns {Promise.<void>}
         */
        async #loadList() {
            const provenance = this.#currentProvenance();
            if (this.#provenance !== provenance) {
                this.invalidate();
            }
            const selected = new Set(
                this.#rows.filter(({ box }) => box.checked).map(({ box }) => box.value),
            );
            const request = ++this.#request;
            const projectRoot = this.#getProjectRoot();
            if (!projectRoot) {
                toast('Select a project folder first.', 'warn');
                return;
            }
            const credBu = this.#getCredBu();
            if (!credBu) {
                toast('Choose a Business Unit first.', 'warn');
                return;
            }
            this.#loading = true;
            for (const { box } of this.#rows) {
                box.disabled = true;
            }
            this.#listStatus.textContent = 'Loading Data Extensions…';
            const result = await globalObject.McConnectionData.listDeItems(projectRoot, credBu);
            if (request !== this.#request) {
                return;
            }
            if (provenance !== this.#currentProvenance()) {
                this.invalidate();
                return;
            }
            this.#loading = false;
            this.#checkList.replaceChildren();
            this.#rows = [];
            this.#updateSelection();
            if (!result.ok) {
                this.#provenance = undefined;
                this.#listStatus.textContent = 'Failed to load: ' + result.error;
                return;
            }
            this.#provenance = provenance;
            if (result.items.length === 0) {
                this.#listStatus.textContent = 'No Data Extensions found in this Business Unit.';
                return;
            }
            this.#listStatus.textContent = `${result.items.length} Data Extensions — check the ones to include.`;
            for (const item of result.items) {
                const box = /** @type {HTMLInputElement} */ (element('input'));
                box.type = 'checkbox';
                box.value = item.key;
                box.checked = selected.has(item.key);
                box.addEventListener('change', () => this.#updateSelection());
                const labelText = item.name === item.key ? item.name : `${item.name} (${item.key})`;
                const row = element('label', { class: 'de-check' });
                row.append(box, element('span', { text: labelText }));
                this.#checkList.append(row);
                this.#rows.push({ box, row, search: `${item.name}\n${item.key}`.toLowerCase() });
            }
            this.#updateSelection();
        }

        /**
         * Filters locally without losing hidden selections and reports the full count.
         *
         * @returns {void}
         */
        #updateSelection() {
            const query = this.#search.value.trim().toLowerCase();
            let visible = 0;
            let selected = 0;
            for (const entry of this.#rows) {
                entry.row.hidden = !entry.search.includes(query);
                if (!entry.row.hidden) {
                    visible++;
                }
                if (entry.box.checked) {
                    selected++;
                }
            }
            this.#selectionStatus.textContent = `${selected} selected · ${visible} of ${this.#rows.length} visible`;
        }

        /**
         * Selects visible rows or clears all selections, including hidden rows.
         *
         * @param {boolean} checked whether to select visible rows
         * @returns {void}
         */
        #setSelection(checked) {
            if (this.#provenance !== this.#currentProvenance()) {
                this.invalidate();
                return;
            }
            if (this.#loading) {
                return;
            }
            for (const { box, row } of this.#rows) {
                if (!checked || !row.hidden) {
                    box.checked = checked;
                }
            }
            this.#updateSelection();
        }

        /**
         * @returns {string} identity of the source and selection context
         */
        #currentProvenance() {
            return JSON.stringify([this.#getProjectRoot(), this.#getCredBu(), this.#getContext()]);
        }

        /**
         * Clears loaded selections and rejects outstanding responses.
         * Manual keys remain an explicitly selected, unverified mode.
         *
         * @returns {void}
         */
        invalidate() {
            this.#request++;
            this.#provenance = undefined;
            this.#loading = false;
            this.#rows = [];
            this.#search.value = '';
            this.#checkList.replaceChildren();
            this.#updateSelection();
            this.#listStatus.textContent = 'Load the list to choose DEs.';
        }

        /**
         * @returns {void}
         */
        dispose() {
            this.invalidate();
            this.#unsubscribe();
        }

        /**
         * @returns {HTMLElement} the control's root node
         */
        get element() {
            return this.#root;
        }

        /**
         * Returns the currently selected DE keys from whichever mode is active.
         * Throws if the active mode has no selection so callers surface a clear
         * validation error.
         *
         * @returns {string[]}
         */
        getKeys() {
            if (this.#modeSelect.value === 'manual') {
                const keys = parseKeys(this.#manualArea.value);
                if (keys.length === 0) {
                    throw new Error('Enter at least one Data Extension key.');
                }
                return keys;
            }
            if (this.#provenance !== this.#currentProvenance()) {
                this.invalidate();
                throw new Error(
                    'Load the Data Extension list for the current project and Business Unit.',
                );
            }
            if (this.#loading) {
                throw new Error('Wait for the Data Extension list to finish refreshing.');
            }
            const checked = this.#checkList.querySelectorAll('input[type="checkbox"]:checked');
            const keys = [...checked].map((box) => /** @type {HTMLInputElement} */ (box).value);
            if (keys.length === 0) {
                throw new Error('Select at least one Data Extension from the list.');
            }
            return keys;
        }
    }

    globalObject.McDeSelector = DeSelector;
})(globalThis);
