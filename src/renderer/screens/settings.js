'use strict';

// Settings screen — currently just the telemetry consent control plus a plain-
// language summary of what is and is not collected. Sandboxed like every other
// screen: it only talks to window.mcdata. Exposed as McScreens.settings.
//
// It also exports initConsentGate(), called once on startup by renderer.js, to
// show the first-run consent modal when consent has never been chosen (undefined).
(function initSettingsScreen(globalObject) {
    const { element, toast } = globalObject.McUI;
    const { field, checkbox, button } = globalObject.McForms;
    const mc = globalObject.mcdata;

    /**
     * Builds the read-only "what we collect" explainer shared by the modal and
     * the settings screen, so the wording never drifts between the two.
     *
     * @returns {HTMLElement}
     */
    function buildExplainer() {
        const wrap = element('div', { class: 'telemetry-explainer' });

        wrap.append(
            element('p', {
                text:
                    'Anonymous usage statistics help improve the app. No personal or ' +
                    'company data is ever collected.',
            }),
        );

        const alwaysTitle = element('p', { class: 'telemetry-subhead' });
        alwaysTitle.append(element('strong', { text: 'Always collected (anonymous):' }));
        wrap.append(alwaysTitle);
        wrap.append(
            buildList([
                'App install, update, and launch (to count active installs)',
                'App version, operating system, and how it was installed',
            ]),
        );

        const optInTitle = element('p', { class: 'telemetry-subhead' });
        optInTitle.append(element('strong', { text: 'Only if you opt in below:' }));
        wrap.append(optInTitle);
        wrap.append(
            buildList([
                'That an export or import ran, and whether it succeeded',
                'File format (CSV/TSV/JSON) and coarse size/row/DE-count buckets',
                'Your app language (e.g. "en") — never region or anything more',
            ]),
        );

        const neverTitle = element('p', { class: 'telemetry-subhead' });
        neverTitle.append(element('strong', { text: 'Never collected:' }));
        wrap.append(neverTitle);
        wrap.append(
            buildList([
                'File names, folder paths, or file contents',
                'Business Unit names, credential names, or any SFMC data',
                'Anything identifying you or your organisation',
            ]),
        );

        return wrap;
    }

    /**
     * @param {string[]} items
     * @returns {HTMLUListElement}
     */
    function buildList(items) {
        const list = /** @type {HTMLUListElement} */ (element('ul', { class: 'telemetry-list' }));
        for (const item of items) {
            list.append(element('li', { text: item }));
        }
        return list;
    }

    /**
     * Persists the consent choice, surfacing a toast on success/failure. Shared
     * by the settings toggle and the modal buttons.
     *
     * @param {boolean} value
     * @returns {Promise.<boolean>} the stored consent, or the requested value on error
     */
    async function saveConsent(value) {
        try {
            const next = await mc.setTelemetryConsent(value);
            return Boolean(next && next.consent);
        } catch {
            toast('Could not save the telemetry setting.', 'error');
            return value;
        }
    }

    /**
     * Mounts the settings screen into the given container.
     *
     * @param {HTMLElement} container
     * @returns {void}
     */
    function mount(container) {
        const root = element('div', { class: 'screen' });
        root.append(element('h2', { text: 'Settings' }));

        const card = element('div', { class: 'card' });
        card.append(element('h3', { text: 'Usage statistics' }));
        card.append(buildExplainer());

        const toggle = checkbox('Send anonymous usage statistics to help improve the app', false);
        card.append(field('Optional usage telemetry', toggle.wrap));

        toggle.input.addEventListener('change', async () => {
            const stored = await saveConsent(toggle.input.checked);
            toggle.input.checked = stored;
            toast(stored ? 'Usage statistics enabled.' : 'Usage statistics disabled.', 'info');
        });

        root.append(card);
        container.append(root);

        // Reflect the persisted value once the bridge answers. Fire-and-forget:
        // any error simply leaves the toggle unchecked.
        void reflectPersistedConsent(toggle);
    }

    /**
     * Reads the stored consent and reflects it on the toggle. Errors leave the
     * toggle unchecked.
     *
     * @param {{ input: HTMLInputElement }} toggle
     * @returns {Promise.<void>}
     */
    async function reflectPersistedConsent(toggle) {
        try {
            const settings = await mc.getSettings();
            toggle.input.checked = settings?.consent === true;
        } catch {
            // leave unchecked on error
        }
    }

    /**
     * On startup, shows a one-time consent modal when the user has never made a
     * choice (consent is undefined). Mandatory lifecycle pings are unaffected by
     * the outcome; only the optional usage events depend on it. Resolves after
     * the choice is stored (or immediately when no prompt is needed).
     *
     * @returns {Promise.<void>}
     */
    async function initConsentGate() {
        let settings;
        try {
            settings = await mc.getSettings();
        } catch {
            return;
        }
        if (!settings || settings.consent === true || settings.consent === false) {
            return;
        }
        await showConsentModal();
    }

    /**
     * Renders the blocking first-run consent modal. Resolves once the user picks
     * an option (either choice is persisted).
     *
     * @returns {Promise.<void>}
     */
    function showConsentModal() {
        return new Promise((resolve) => {
            const overlay = element('div', { class: 'modal-overlay' });
            const dialog = element('div', { class: 'modal' });
            dialog.append(element('h2', { text: 'Help improve SFMC Data Loader' }));
            dialog.append(buildExplainer());

            const actions = element('div', { class: 'modal-actions' });
            const noButton = button('No thanks', { variant: 'btn-secondary' });
            const yesButton = button('Enable usage statistics');
            actions.append(noButton, yesButton);
            dialog.append(actions);
            overlay.append(dialog);
            document.body.append(overlay);

            /**
             * @param {boolean} value
             * @returns {Promise.<void>}
             */
            const choose = async (value) => {
                noButton.disabled = true;
                yesButton.disabled = true;
                await saveConsent(value);
                overlay.remove();
                resolve();
            };

            noButton.addEventListener('click', () => choose(false));
            yesButton.addEventListener('click', () => choose(true));
        });
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.settings = { mount };
    globalObject.McSettings = { initConsentGate };
})(globalThis);
