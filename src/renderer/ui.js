'use strict';

// Small, dependency-free UI helpers shared by every screen. Exposed on the
// global `McUI` because the sandboxed renderer loads plain <script> files under
// a file:// origin (no bundler, no ES module graph). Nothing here touches Node
// or ipcRenderer — privileged calls always go through window.mcdata.
(function initUi(globalObject) {
    /**
     * Creates an element with optional class names, text, and attributes.
     *
     * @param {string} tag
     * @param {{ class?: string, text?: string, attrs?: Record<string, string> }} [options]
     * @returns {HTMLElement}
     */
    function element(tag, options) {
        const node = document.createElement(tag);
        if (options && options.class) {
            node.className = options.class;
        }
        if (options && typeof options.text === 'string') {
            node.textContent = options.text;
        }
        if (options && options.attrs) {
            for (const [key, value] of Object.entries(options.attrs)) {
                node.setAttribute(key, value);
            }
        }
        return node;
    }

    /**
     * Ensures the singleton toast container exists and returns it.
     *
     * @returns {HTMLElement}
     */
    function toastContainer() {
        let container = document.querySelector('#toasts');
        if (!container) {
            container = element('div', { attrs: { id: 'toasts' } });
            document.body.append(container);
        }
        return container;
    }

    /**
     * Shows a transient toast notification.
     *
     * @param {string} message
     * @param {'info'|'success'|'warn'|'error'} [type]
     * @param {number} [durationMs]
     * @returns {void}
     */
    function toast(message, type, durationMs) {
        const kind = type || 'info';
        const node = element('div', { class: 'toast toast-' + kind, text: message });
        toastContainer().append(node);
        const timeout = typeof durationMs === 'number' ? durationMs : 5000;
        setTimeout(() => {
            node.classList.add('toast-leaving');
            setTimeout(() => node.remove(), 250);
        }, timeout);
    }

    /**
     * Removes every child of a node.
     *
     * @param {HTMLElement} node
     * @returns {void}
     */
    function clear(node) {
        node.replaceChildren();
    }

    globalObject.McUI = { element, toast, clear };
})(globalThis);
