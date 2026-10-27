'use strict';

// A reusable Business Unit picker shared by the Export and Import screens. It
// shows saved `credential/BU` connections in a dropdown (populated from the
// project config) with an "Enter manually…" fallback for advanced users or BUs
// that are not yet saved. Auto-refreshes when the project folder changes.
// Exposed as the global `McBuPicker`.
(function initBuPicker(globalObject) {
    const { element } = globalObject.McUI;
    const { field, input } = globalObject.McForms;

    const MANUAL = '__manual__';

    class BuPicker {
        /**
         * @type {HTMLElement}
         */
        #root;
        /**
         * @type {HTMLSelectElement}
         */
        #select;
        /**
         * @type {HTMLInputElement}
         */
        #manualInput;
        /**
         * @type {HTMLElement}
         */
        #manualWrap;
        /**
         * @type {() => void}
         */
        #unsubscribe;
        #request = 0;
        #projectRoot;
        #listeners = new Set();
        #multiple;
        #search;
        #checkList;
        #options = [];
        #selected = new Set();
        #manualArea;

        /**
         * @param {{ label?: string, hint?: string, multiple?: boolean }} [options]
         */
        constructor(options) {
            const label = options?.label ?? 'Business Unit';
            const hint = options?.hint;

            this.#select = /** @type {HTMLSelectElement} */ (element('select'));
            this.#manualInput = input({ placeholder: 'credential/businessUnit' });
            this.#manualWrap = field('Enter credential/BU', this.#manualInput);
            this.#manualWrap.style.display = 'none';

            this.#select.addEventListener('change', () => {
                this.#applyMode();
                this.#notify();
            });
            this.#manualInput.addEventListener('input', () => this.#notify());

            this.#root = element('div', { class: 'bu-picker' });
            this.#multiple = options?.multiple === true;
            if (this.#multiple) {
                this.#search = input({ type: 'search', placeholder: 'Search credentials or BUs' });
                this.#search.addEventListener('input', () => this.#renderChoices());
                this.#checkList = element('div', { class: 'bu-checklist' });
                this.#manualArea = /** @type {HTMLTextAreaElement} */ (element('textarea'));
                this.#manualArea.rows = 3;
                this.#manualArea.placeholder = 'MyOrg/BU-A\nOtherOrg/BU-B';
                this.#manualArea.addEventListener('input', () => this.#notify());
                this.#root.append(
                    element('p', { class: 'field-label', text: label }),
                    field('Search saved Business Units', this.#search, hint),
                    this.#checkList,
                    field(
                        'Additional Business Units (manual)',
                        this.#manualArea,
                        'credential/BU tokens, comma or newline separated; added after checked BUs',
                    ),
                );
            } else {
                this.#root.append(field(label, this.#select, hint), this.#manualWrap);
            }

            this.#unsubscribe = globalObject.McState.subscribe(() => void this.refresh());
            void this.refresh();
        }

        /**
         * Renders filtered choices without losing hidden selections or selection order.
         *
         * @returns {void}
         */
        #renderChoices() {
            const query = this.#search.value.trim().toLowerCase();
            this.#checkList.replaceChildren();
            for (const option of this.#options) {
                if (!`${option.label} ${option.value}`.toLowerCase().includes(query)) {
                    continue;
                }
                const box = input({ type: 'checkbox' });
                box.value = option.value;
                box.checked = this.#selected.has(option.value);
                box.addEventListener('change', () => {
                    if (box.checked) {
                        this.#selected.add(option.value);
                    } else {
                        this.#selected.delete(option.value);
                    }
                    this.#notify();
                });
                const row = element('label', { class: 'checkbox' });
                row.append(box, element('span', { text: `${option.label} (${option.value})` }));
                this.#checkList.append(row);
            }
            if (this.#checkList.children.length === 0) {
                this.#checkList.append(
                    element('p', {
                        class: 'muted',
                        text: 'No matching saved Business Units. Manual entry is available below.',
                    }),
                );
            }
        }

        /**
         * @returns {void}
         */
        #applyMode() {
            this.#manualWrap.style.display = this.#select.value === MANUAL ? '' : 'none';
        }

        /**
         * Notifies dependents immediately when the effective BU changes.
         *
         * @returns {void}
         */
        #notify() {
            for (const listener of this.#listeners) {
                listener();
            }
        }

        /**
         * Repopulates the dropdown from the current project's saved connections,
         * always keeping the "Enter manually…" fallback last.
         *
         * @returns {Promise.<void>}
         */
        async refresh() {
            const projectRoot = globalObject.McState.get().projectRoot;
            const request = ++this.#request;
            const isChangedProject = this.#projectRoot !== projectRoot;
            let previous = isChangedProject ? '' : this.#select.value;
            this.#projectRoot = projectRoot;
            if (isChangedProject) {
                this.#select.replaceChildren();
                this.#manualInput.value = '';
                if (this.#multiple) {
                    this.#selected.clear();
                    this.#options = [];
                    this.#search.value = '';
                    this.#manualArea.value = '';
                    this.#renderChoices();
                }
                this.#notify();
            }
            const before = JSON.stringify(this.getValues());
            const options = await globalObject.McConnectionData.listCredBuOptions(projectRoot);
            if (
                request !== this.#request ||
                projectRoot !== globalObject.McState.get().projectRoot
            ) {
                return;
            }

            if (this.#multiple) {
                const current = JSON.stringify(this.getValues());
                this.#options = options;
                const available = new Set(options.map((option) => option.value));
                this.#selected = new Set(
                    [...this.#selected].filter((value) => available.has(value)),
                );
                this.#renderChoices();
                if (current !== JSON.stringify(this.getValues())) {
                    this.#notify();
                }
                return;
            }

            previous = this.#select.value || previous;
            this.#select.replaceChildren();
            if (options.length === 0) {
                const empty = /** @type {HTMLOptionElement} */ (
                    element('option', { text: 'No saved connections — enter manually' })
                );
                empty.value = MANUAL;
                this.#select.append(empty);
            } else {
                for (const opt of options) {
                    const node = /** @type {HTMLOptionElement} */ (
                        element('option', { text: opt.label })
                    );
                    node.value = opt.value;
                    this.#select.append(node);
                }
                const manualNode = /** @type {HTMLOptionElement} */ (
                    element('option', { text: 'Enter manually…' })
                );
                manualNode.value = MANUAL;
                this.#select.append(manualNode);
            }

            // preserve the prior selection when still available
            const isStillThere = [...this.#select.options].some((o) => o.value === previous);
            if (isStillThere) {
                this.#select.value = previous;
            }
            this.#applyMode();
            if (before !== JSON.stringify(this.getValues())) {
                this.#notify();
            }
        }

        /**
         * @param {() => void} listener
         * @returns {() => void}
         */
        onChange(listener) {
            this.#listeners.add(listener);
            return () => this.#listeners.delete(listener);
        }

        /**
         * @returns {HTMLElement} the control's root node
         */
        get element() {
            return this.#root;
        }

        /**
         * Returns the selected `credential/BU` token (manual entry when the
         * fallback is active). Empty string when nothing usable is set.
         *
         * @returns {string}
         */
        getValue() {
            if (this.#multiple) {
                return this.getValues()[0] ?? '';
            }
            if (this.#select.value === MANUAL) {
                return this.#manualInput.value.trim();
            }
            return this.#select.value;
        }

        /**
         * Returns ordered, deduplicated tokens; manual entries follow checked BUs.
         *
         * @returns {string[]}
         */
        getValues() {
            if (!this.#multiple) {
                const value = this.getValue();
                return value ? [value] : [];
            }
            // Submission must not reuse selections from a different project, even
            // if a state subscriber has not run yet.
            if (this.#projectRoot !== globalObject.McState.get().projectRoot) {
                return [];
            }
            const manual = this.#manualArea.value
                .split(/[\n,]+/)
                .map((value) => value.trim())
                .filter(Boolean);
            return [...new Set([...this.#selected, ...manual])];
        }

        /**
         * Detaches the state subscription. Call when the screen is torn down.
         *
         * @returns {void}
         */
        dispose() {
            this.#request++;
            this.#unsubscribe();
            this.#listeners.clear();
        }
    }

    globalObject.McBuPicker = BuPicker;
})(globalThis);
