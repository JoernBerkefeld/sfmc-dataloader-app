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
        /** @type {() => string} */
        #getCredBu;
        /** @type {HTMLElement} */
        #root;
        /** @type {HTMLSelectElement} */
        #modeSelect;
        /** @type {HTMLElement} */
        #listWrap;
        /** @type {HTMLElement} */
        #checkList;
        /** @type {HTMLElement} */
        #listStatus;
        /** @type {HTMLTextAreaElement} */
        #manualArea;
        /** @type {HTMLElement} */
        #manualWrap;

        /**
         * @param {{ getCredBu: () => string }} options
         */
        constructor(options) {
            this.#getCredBu = options.getCredBu;
            this.#root = this.#build();
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
            listActions.append(loadButton);
            this.#listWrap.append(listActions, this.#listStatus, this.#checkList);

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
            const projectRoot = globalObject.McState.get().projectRoot;
            if (!projectRoot) {
                toast('Select a project folder first.', 'warn');
                return;
            }
            const credBu = this.#getCredBu();
            if (!credBu) {
                toast('Choose a Business Unit first.', 'warn');
                return;
            }
            this.#checkList.replaceChildren();
            this.#listStatus.textContent = 'Loading Data Extensions…';
            const result = await globalObject.McConnectionData.listDeItems(projectRoot, credBu);
            if (!result.ok) {
                this.#listStatus.textContent = 'Failed to load: ' + result.error;
                return;
            }
            if (result.items.length === 0) {
                this.#listStatus.textContent = 'No Data Extensions found in this Business Unit.';
                return;
            }
            this.#listStatus.textContent = `${result.items.length} Data Extensions — check the ones to include.`;
            for (const item of result.items) {
                const box = /** @type {HTMLInputElement} */ (element('input'));
                box.type = 'checkbox';
                box.value = item.key;
                const labelText = item.name === item.key ? item.name : `${item.name} (${item.key})`;
                const row = element('label', { class: 'de-check' });
                row.append(box, element('span', { text: labelText }));
                this.#checkList.append(row);
            }
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
