'use strict';

// Renders the auto-update banner from the update:status event stream. Like the
// rest of the renderer this is sandboxed: it only talks to window.mcdata and
// derives display text from the shared McUpdate helper. Exposed as
// globalThis.McUpdates so renderer.js can initialise it on DOMContentLoaded.
(function initUpdates(globalObject) {
    const { describeUpdateStatus, UPDATE_STATUS } = globalObject.McUpdate;

    /**
     * Wires the banner DOM to the updater bridge. Idempotent: safe to call once
     * after the DOM is ready.
     *
     * @returns {void}
     */
    function init() {
        const banner = document.querySelector('#update-banner');
        const textElement = document.querySelector('#update-text');
        const installButton = document.querySelector('#update-install');
        const dismissButton = document.querySelector('#update-dismiss');
        const mc = globalObject.mcdata;
        if (!banner || !textElement || !installButton || !dismissButton || !mc) {
            return;
        }

        /**
         * Paints the banner for a given update state. Hides itself for idle and
         * for the transient "checking" state so the header stays quiet unless
         * there is something actionable or noteworthy to show.
         *
         * @param {object} state
         * @returns {void}
         */
        const render = (state) => {
            const status = state && state.status;
            if (!status || status === UPDATE_STATUS.IDLE || status === UPDATE_STATUS.CHECKING) {
                banner.hidden = true;
                return;
            }
            const view = describeUpdateStatus(state);
            textElement.textContent = view.text;
            installButton.hidden = !view.canInstall;
            banner.hidden = false;
        };

        installButton.addEventListener('click', () => {
            installButton.disabled = true;
            mc.installUpdate();
        });
        dismissButton.addEventListener('click', () => {
            banner.hidden = true;
        });

        mc.onUpdateStatus(render);
    }

    globalObject.McUpdates = { init };
})(globalThis);
