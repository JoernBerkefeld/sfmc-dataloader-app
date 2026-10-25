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

        /**
         * @param {{ label?: string, hint?: string }} [options]
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
            this.#root.append(field(label, this.#select, hint), this.#manualWrap);

            this.#unsubscribe = globalObject.McState.subscribe(() => void this.refresh());
            void this.refresh();
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
                this.#notify();
            }
            const before = this.getValue();
            const options = await globalObject.McConnectionData.listCredBuOptions(projectRoot);
            if (
                request !== this.#request ||
                projectRoot !== globalObject.McState.get().projectRoot
            ) {
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
            if (before !== this.getValue()) {
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
            if (this.#select.value === MANUAL) {
                return this.#manualInput.value.trim();
            }
            return this.#select.value;
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
