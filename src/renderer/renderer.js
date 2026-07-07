'use strict';

// Renderer entry point / router. The renderer is sandboxed: all privileged calls
// go through window.mcdata (see src/preload/preload.js). No Node APIs here.
// Screens are plain factory objects registered on globalThis.McScreens and are
// (re)mounted into #view when their tab is activated.
(function initRenderer(globalObject) {
    const { clear } = globalObject.McUI;

    /**
     * Mounts the screen matching the given view id into #view.
     *
     * @param {string} view
     * @returns {void}
     */
    function activate(view) {
        const container = document.querySelector('#view');
        const screen = globalObject.McScreens[view];
        if (!container || !screen) {
            return;
        }
        clear(container);
        screen.mount(container);
    }

    /**
     * Wires the tab buttons to screen activation.
     *
     * @returns {void}
     */
    function initTabs() {
        const tabs = document.querySelectorAll('.tab');
        for (const tab of tabs) {
            tab.addEventListener('click', () => {
                for (const other of tabs) {
                    other.classList.toggle('active', other === tab);
                }
                activate(tab.dataset.view);
            });
        }
    }

    /**
     * Populates the header version/runtime line.
     *
     * @returns {Promise.<void>}
     */
    async function showRuntimeInfo() {
        try {
            const info = await globalObject.mcdata.getAppInfo();
            const versionElement = document.querySelector('#app-version');
            if (versionElement) {
                versionElement.textContent = 'v' + info.appVersion;
            }
        } catch {
            // header version is cosmetic; ignore bridge errors here
        }
    }

    /**
     * Keeps the header's active-project label in sync with McState.
     *
     * @returns {void}
     */
    function initProjectLabel() {
        const label = document.querySelector('#project-label');
        const render = (state) => {
            if (label) {
                label.textContent = state.projectRoot || 'No project folder selected';
            }
        };
        globalObject.McState.subscribe(render);
        render(globalObject.McState.get());
    }

    addEventListener('DOMContentLoaded', () => {
        initTabs();
        initProjectLabel();
        showRuntimeInfo();
        globalObject.McUpdates.init();
        activate('connections');
    });
})(globalThis);
