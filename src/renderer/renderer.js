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

    /**
     * Restores the last selected project folder from persisted settings so the
     * app reopens on the folder the user last worked in. Best-effort: a bridge
     * error simply leaves the project unset.
     *
     * @returns {Promise.<void>}
     */
    async function restoreProjectRoot() {
        try {
            const settings = await globalObject.mcdata.getSettings();
            if (settings && typeof settings.projectRoot === 'string' && settings.projectRoot) {
                globalObject.McState.set({ projectRoot: settings.projectRoot });
            }
        } catch {
            // no persisted project folder; start unset
        }
    }

    addEventListener('DOMContentLoaded', async () => {
        initTabs();
        initProjectLabel();
        showRuntimeInfo();
        globalObject.McUpdates.init();
        // Restore the persisted project folder before mounting so the connections
        // screen and header reflect it immediately.
        await restoreProjectRoot();
        activate('connections');
        // First-run telemetry consent prompt (no-op once the user has chosen).
        globalObject.McSettings.initConsentGate();
    });
})(globalThis);
