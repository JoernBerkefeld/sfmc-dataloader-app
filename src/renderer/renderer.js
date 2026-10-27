'use strict';

// Renderer entry point / router. The renderer is sandboxed: all privileged calls
// go through window.mcdata (see src/preload/preload.js). No Node APIs here.
// Screens are plain factory objects registered on globalThis.McScreens and are
// lazily mounted once, then retained while their tab is hidden.
(function initRenderer(globalObject) {
    const mounted = new Map();
    let activeView;

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
        for (const tab of document.querySelectorAll('.tab')) {
            const isActive = tab.dataset.view === view;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-current', isActive ? 'page' : 'false');
        }
        if (activeView === view) {
            return;
        }
        let host = mounted.get(view);
        if (!host) {
            host = document.createElement('div');
            container.append(host);
            screen.mount(host);
            mounted.set(view, host);
        }
        for (const [id, node] of mounted) {
            node.hidden = id !== view;
        }
        activeView = view;
        screen.activate?.();
    }

    /**
     * Wires the tab buttons to screen activation.
     *
     * @returns {void}
     */
    function initTabs() {
        const tabs = document.querySelectorAll('.tab');
        for (const tab of tabs) {
            tab.addEventListener('click', () => activate(tab.dataset.view));
        }
    }

    /**
     * Keeps active work reachable without remounting its screen or runner.
     *
     * @returns {void}
     */
    function initActiveJob() {
        const banner = document.querySelector('#active-job');
        const status = document.querySelector('#active-job-status');
        const button = document.querySelector('#active-job-return');
        if (!banner || !status || !button) {
            return;
        }
        let current;
        globalObject.JobRunner.subscribeActive((job) => {
            current = job;
            banner.hidden = !job;
            if (job) {
                status.textContent = `${job.label}: ${job.status}`;
                button.textContent = `Return to ${job.label.toLowerCase()} job`;
            } else {
                status.textContent = '';
                // Do not strand keyboard focus in a newly hidden banner.
                if (document.activeElement === button) {
                    document.querySelector('.tab.active')?.focus();
                }
            }
        });
        button.addEventListener('click', () => {
            if (!current) {
                return;
            }
            activate(current.view);
            mounted.get(current.view)?.querySelector('.job-runner')?.focus();
        });
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
        initActiveJob();
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
