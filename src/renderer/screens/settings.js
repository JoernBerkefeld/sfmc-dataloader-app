'use strict';

// Settings screen — currently just the telemetry consent control plus a plain-
// language summary of what is and is not collected. Sandboxed like every other
// screen: it only talks to window.mcdata. Exposed as McScreens.settings.
//
// It also exports initConsentGate(), called once on startup by renderer.js, to
// show the first-run consent modal when consent has never been chosen (undefined).
(function initSettingsScreen(globalObject) {
    const { element } = globalObject.McUI;
    const { field, select, checkbox, button } = globalObject.McForms;
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
                    'Optional usage statistics use a pseudonymous random installation ID that links events from this installation; it is not guaranteed anonymous. ' +
                    "PostHog's EU ingestion endpoint also receives network metadata, including your IP address. " +
                    'No analytics events are sent until affirmative consent is saved. Turn off all telemetry here at any time. ' +
                    'Events already delivered cannot be recalled.',
            }),
        );

        const alwaysTitle = element('p', { class: 'telemetry-subhead' });
        alwaysTitle.append(element('strong', { text: 'Only with your permission:' }));
        wrap.append(alwaysTitle);
        wrap.append(
            buildList([
                'First consenting run, app updates and launches (not a count of all installs)',
                'App and loader versions, operating system/version, architecture, and installation channel',
            ]),
        );

        const optInTitle = element('p', { class: 'telemetry-subhead' });
        optInTitle.append(element('strong', { text: 'Only if you opt in below:' }));
        wrap.append(optInTitle);
        wrap.append(
            buildList([
                'Export/import usage, job outcomes (including connection setup), and configuration-load/discovery outcomes',
                'File format, import mode, multi-/cross-BU flags, project-presence booleans, and coarse file/DE/BU-count, size, row-count, and duration buckets',
                'Closed error categories, names, and codes — never raw error messages or stacks',
                'Your app language (e.g. "en"), without its region subtag',
            ]),
        );

        const neverTitle = element('p', { class: 'telemetry-subhead' });
        neverTitle.append(element('strong', { text: 'Never included in analytics payloads:' }));
        wrap.append(neverTitle);
        wrap.append(
            buildList([
                'File names, folder/project paths, file contents, or row values',
                'Business Unit names/MIDs, tenant identities, credential labels, or DE keys/field names',
                'Credentials, auth URLs, tokens, raw error messages/stacks, or user-supplied names/email addresses',
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
     * @returns {Promise.<object | undefined>} explicit session state and persistence outcome
     */
    async function saveConsent(value) {
        try {
            return await mc.setTelemetryConsent(value);
        } catch {
            return;
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

        const toggle = checkbox('Allow usage statistics, including app launches', false);
        card.append(field('All app telemetry (optional)', toggle.wrap));
        const status = element('p', { attrs: { role: 'status' } });
        let isRequestedConsent = false;
        const retry = button('Retry saving telemetry', { variant: 'btn-secondary' });
        retry.hidden = true;
        card.append(status, retry);

        /**
         * @param {object} settings
         * @returns {void}
         */
        function renderState(settings) {
            if (settings) {
                toggle.input.checked = settings.consent === true;
            }
            const isSaved = settings?.persistence?.saved === true;
            if (isSaved) {
                status.textContent = 'Telemetry setting saved for next launch.';
            } else if (settings) {
                status.textContent =
                    settings.consent === true
                        ? 'Telemetry is enabled from a previously saved choice; app settings could not be saved. Retry saving.'
                        : 'Telemetry is disabled this session; choice not saved for next launch. Retry saving.';
            } else {
                status.textContent = 'Could not confirm telemetry state or save. Retry saving.';
            }
            retry.hidden = isSaved;
        }

        const defaultsCard = element('div', { class: 'card' });
        defaultsCard.append(element('h3', { text: 'Transfer defaults' }));
        const format = select(
            ['csv', 'tsv', 'json'].map((value) => ({ value, label: value.toUpperCase() })),
            'csv',
        );
        const mode = select(
            ['upsert', 'insert'].map((value) => ({ value, label: value })),
            'upsert',
        );
        const git = checkbox('Stable export filenames (--git)', false);
        const backup = checkbox('Backup before import', true);
        const skip = checkbox('Skip empty lines (CSV/TSV)', true);
        const debug = checkbox('Enable debug logs', false);
        const defaultsStatus = element('p', { attrs: { role: 'status' } });
        const saveDefaults = button('Save transfer defaults');
        defaultsCard.append(
            field('Export format', format),
            field('Import write mode', mode),
            git.wrap,
            backup.wrap,
            skip.wrap,
            debug.wrap,
            element('p', {
                text: 'Debug logs may contain sensitive API data. Share them carefully.',
            }),
            element('p', {
                text: 'Transfer screens allow per-run overrides. Clear is never saved as a default. Skip empty lines includes blank, delimiter-only and quoted-empty records; automatic file-edge cleanup is independent.',
            }),
            defaultsStatus,
            saveDefaults,
        );
        let defaultsRevision = 0;
        for (const control of [format, mode, git.input, backup.input, skip.input, debug.input]) {
            control.addEventListener('change', () => {
                defaultsRevision++;
                defaultsStatus.textContent = 'Transfer defaults changed; not saved yet.';
            });
        }
        saveDefaults.addEventListener('click', async () => {
            defaultsRevision++;
            saveDefaults.disabled = true;
            for (const control of [
                format,
                mode,
                git.input,
                backup.input,
                skip.input,
                debug.input,
            ]) {
                control.disabled = true;
            }
            try {
                const result = await mc.setTransferDefaults({
                    format: format.value,
                    mode: mode.value,
                    git: git.input.checked,
                    backupBeforeImport: backup.input.checked,
                    skipEmptyLines: skip.input.checked,
                    debug: debug.input.checked,
                });
                const isSaved = result?.persistence?.saved === true;
                defaultsStatus.textContent = isSaved
                    ? 'Transfer defaults saved for next launch.'
                    : 'Transfer defaults apply this session only; not saved for next launch. Retry saving.';
                saveDefaults.textContent = isSaved
                    ? 'Save transfer defaults'
                    : 'Retry saving transfer defaults';
            } catch {
                defaultsStatus.textContent =
                    'Could not confirm transfer defaults or save. Retry saving.';
                saveDefaults.textContent = 'Retry saving transfer defaults';
            } finally {
                saveDefaults.disabled = false;
                for (const control of [
                    format,
                    mode,
                    git.input,
                    backup.input,
                    skip.input,
                    debug.input,
                ]) {
                    control.disabled = false;
                }
            }
        });

        let revision = 0;
        globalObject.McScreens.settings.activate = async () => {
            const request = ++revision;
            const defaultsRequest = defaultsRevision;
            try {
                const settings = await mc.getSettings();
                if (request === revision) {
                    renderState(settings);
                }
                if (defaultsRequest === defaultsRevision && settings?.transferDefaults) {
                    const defaults = settings.transferDefaults;
                    format.value = defaults.format;
                    mode.value = defaults.mode;
                    git.input.checked = defaults.git;
                    backup.input.checked = defaults.backupBeforeImport;
                    skip.input.checked = defaults.skipEmptyLines;
                    debug.input.checked = defaults.debug;
                    defaultsStatus.textContent = settings.persistence?.saved
                        ? 'Transfer defaults saved for next launch.'
                        : 'Session defaults are not saved for next launch. Retry saving.';
                }
            } catch {
                if (request === revision) {
                    renderState();
                }
            }
        };

        /**
         * @returns {Promise.<void>}
         */
        async function save() {
            revision++;
            toggle.input.disabled = true;
            retry.disabled = true;
            const next = await saveConsent(isRequestedConsent);
            renderState(next);
            toggle.input.disabled = false;
            retry.disabled = false;
        }
        toggle.input.addEventListener('change', () => {
            isRequestedConsent = toggle.input.checked;
            return save();
        });
        retry.addEventListener('click', save);

        root.append(defaultsCard, card);
        container.append(root);
    }

    /**
     * On startup, shows a one-time consent modal when the user has never made a
     * choice (consent is undefined). All telemetry stays disabled until an
     * affirmative choice is saved. Escape leaves consent pending and disabled.
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
     * Renders the first-run native modal. A choice is persisted; Escape leaves
     * consent undecided. Resolves after dismissal or saving the selected option.
     *
     * @returns {Promise.<void>}
     */
    function showConsentModal() {
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            const dialog = /** @type {HTMLDialogElement} */ (
                element('dialog', {
                    class: 'modal',
                    attrs: { 'aria-labelledby': 'consent-title' },
                })
            );
            dialog.append(
                element('h2', {
                    text: 'Help improve SFMC Data Loader',
                    attrs: { id: 'consent-title' },
                }),
            );
            dialog.append(buildExplainer());

            const status = element('p', { attrs: { role: 'status' } });
            dialog.append(status);
            const actions = element('div', { class: 'modal-actions' });
            const noButton = button('No thanks', { variant: 'btn-secondary' });
            const yesButton = button('Enable usage statistics');
            actions.append(noButton, yesButton);
            dialog.append(actions);
            document.body.append(dialog);
            let isChoosing = false;
            dialog.addEventListener('cancel', (event) => {
                if (isChoosing) {
                    event.preventDefault();
                }
            });
            dialog.addEventListener(
                'close',
                () => {
                    dialog.remove();
                    if (previousFocus?.isConnected) {
                        previousFocus.focus();
                    }
                    resolve();
                },
                { once: true },
            );

            /**
             * @param {boolean} value
             * @returns {Promise.<void>}
             */
            const choose = async (value) => {
                if (isChoosing) {
                    return;
                }
                isChoosing = true;
                noButton.disabled = true;
                yesButton.disabled = true;
                const next = await saveConsent(value);
                if (next?.persistence?.saved === true) {
                    dialog.close();
                    return;
                }
                status.textContent = next
                    ? 'Telemetry is disabled this session; choice not saved for next launch. Choose again to retry, or press Escape to continue.'
                    : 'Could not confirm the choice or save. Choose again to retry, or press Escape to continue.';
                isChoosing = false;
                noButton.disabled = false;
                yesButton.disabled = false;
            };

            noButton.addEventListener('click', () => choose(false));
            yesButton.addEventListener('click', () => choose(true));
            dialog.showModal();
            noButton.focus();
        });
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.settings = { mount };
    globalObject.McSettings = { initConsentGate };
})(globalThis);
