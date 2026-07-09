'use strict';

// Connections screen — the auth-config surface. It does three things:
//   1. picks the project folder every job is scoped to (holds .mcdatarc.json);
//   2. lists the saved connections/business units read back from that folder;
//   3. adds a connection by running an INIT job (fetches BUs + writes the
//      config pair) and lets the user test a BU by listing its DEs.
//
// The client secret is only ever entered here and handed to an INIT job, which
// runs sfmc-dataloader's `main(['init', ...])` in the isolated worker process —
// so it never reaches the OS process table. Reading config back never returns
// secrets (see src/main/config-service.js). Exposed as McScreens.connections.
(function initConnectionsScreen(globalObject) {
    const { element, toast, clear } = globalObject.McUI;
    const { field, input, checkbox, button, directoryPicker } = globalObject.McForms;
    const { JOB_KIND } = globalObject.mcdata;

    /**
     * Mounts the connections screen.
     *
     * @param {HTMLElement} container
     * @returns {void}
     */
    function mount(container) {
        const root = element('div', { class: 'screen' });
        root.append(element('h2', { text: 'Connections' }));
        root.append(
            element('p', {
                class: 'muted',
                text: 'Choose your project folder, then add a Marketing Cloud connection. Credentials are stored in .mcdatarc.json / .mcdata-auth.json inside that folder.',
            }),
        );

        // ── Project folder ───────────────────────────────────────────────────
        const picker = directoryPicker({
            placeholder: 'Select your sfmc-dataloader project folder',
        });
        picker.input.value = globalObject.McState.get().projectRoot;
        const projectField = field('Project folder', picker.wrap);

        const useButton = button('Use this folder');
        const openButton = button('Open in file manager', { variant: 'btn-secondary' });
        const projectActions = element('div', { class: 'form-actions' });
        projectActions.append(useButton, openButton);

        // ── Saved connections ────────────────────────────────────────────────
        const savedSection = element('div', { class: 'card' });
        savedSection.append(element('h3', { text: 'Saved connections' }));
        const savedList = element('div', { class: 'saved-list' });
        const savedStatus = element('p', { class: 'muted' });
        savedSection.append(savedStatus, savedList);

        // ── Add connection ───────────────────────────────────────────────────
        const addSection = element('div', { class: 'card' });
        addSection.append(element('h3', { text: 'Add connection' }));
        addSection.append(
            element('p', {
                class: 'muted',
                text: 'Enter the credentials of an installed package (Server-to-Server) with Data Extension access. Business units are fetched automatically.',
            }),
        );

        const credInput = input({ placeholder: 'MyOrg' });
        const credField = field('Credential name', credInput, 'a label of your choice, e.g. MyOrg');

        const clientIdInput = input({ placeholder: 'installed package client id' });
        const clientIdField = field('Client ID', clientIdInput);

        const clientSecretInput = input({
            type: 'password',
            placeholder: 'installed package client secret',
        });
        const clientSecretField = field('Client Secret', clientSecretInput);

        const authUrlInput = input({
            placeholder: 'https://<subdomain>.auth.marketingcloudapis.com/',
        });
        const authUrlField = field('Auth URL', authUrlInput);

        const eidInput = input({ type: 'number', placeholder: 'e.g. 7100000' });
        const eidField = field('Enterprise MID', eidInput, 'the parent (enterprise) account id');

        const overwrite = checkbox('Overwrite an existing configuration', false);

        const saveButton = button('Fetch business units & save');
        const addActions = element('div', { class: 'form-actions' });
        addActions.append(saveButton);

        const runner = new globalObject.JobRunner();

        const credRow = element('div', { class: 'form-row' });
        credRow.append(credField, eidField);
        addSection.append(
            credRow,
            clientIdField,
            clientSecretField,
            authUrlField,
            overwrite.wrap,
            addActions,
            runner.element,
        );

        // ── behaviour ────────────────────────────────────────────────────────

        /**
         * Refreshes the saved-connections list from the current project folder.
         *
         * @returns {Promise.<void>}
         */
        async function refreshSaved() {
            const projectRoot = globalObject.McState.get().projectRoot;
            clear(savedList);
            if (!projectRoot) {
                savedStatus.textContent = 'Select and use a project folder to see its connections.';
                return;
            }
            savedStatus.textContent = 'Loading…';
            let result;
            try {
                result = await globalObject.mcdata.loadConfig(projectRoot);
            } catch (ex) {
                savedStatus.textContent = 'Could not read config: ' + (ex?.message ?? String(ex));
                return;
            }
            if (!result.configured || result.credentials.length === 0) {
                savedStatus.textContent =
                    result.message || 'No connection saved yet — add one below.';
                return;
            }
            savedStatus.textContent = '';
            for (const cred of result.credentials) {
                savedList.append(renderCredential(cred));
            }
        }

        /**
         * Renders one saved credential with its business units and a per-BU
         * "Test / list DEs" action.
         *
         * @param {{credential: string, eid: (number | undefined), businessUnits: {name: string, mid: (number | string)}[]}} cred
         * @returns {HTMLElement}
         */
        function renderCredential(cred) {
            const block = element('div', { class: 'saved-cred' });
            const eidSuffix = cred.eid ? ' (EID ' + cred.eid + ')' : '';
            block.append(element('h4', { text: cred.credential + eidSuffix }));

            if (cred.businessUnits.length === 0) {
                block.append(element('p', { class: 'muted', text: 'No business units found.' }));
                return block;
            }

            for (const bu of cred.businessUnits) {
                const row = element('div', { class: 'saved-bu' });
                row.append(element('span', { class: 'bu-name', text: bu.name }));
                row.append(element('span', { class: 'muted', text: 'MID ' + bu.mid }));

                const testButton = button('Test / list DEs', { variant: 'btn-secondary' });
                const testStatus = element('span', { class: 'muted' });
                testButton.addEventListener('click', () =>
                    testConnection(cred.credential, bu.name, testButton, testStatus),
                );
                row.append(testButton, testStatus);
                block.append(row);
            }
            return block;
        }

        /**
         * Lists the DEs for a credential/BU to prove the saved credentials work.
         *
         * @param {string} credential
         * @param {string} bu
         * @param {HTMLButtonElement} testButton
         * @param {HTMLElement} testStatus
         * @returns {Promise.<void>}
         */
        async function testConnection(credential, bu, testButton, testStatus) {
            const projectRoot = globalObject.McState.get().projectRoot;
            if (!projectRoot) {
                toast('Select a project folder first.', 'warn');
                return;
            }
            testButton.setAttribute('disabled', 'true');
            testStatus.textContent = 'Connecting…';
            let result;
            try {
                result = await globalObject.mcdata.fetchDeList({ projectRoot, credential, bu });
            } catch (ex) {
                result = { ok: false, error: ex?.message ?? String(ex) };
            }
            testButton.removeAttribute('disabled');
            if (result.ok) {
                const count = result.items.length;
                testStatus.textContent = `OK — ${count} Data Extension${count === 1 ? '' : 's'}`;
                toast(`${credential}/${bu}: ${count} Data Extensions found.`, 'success');
            } else {
                testStatus.textContent = 'Failed';
                toast('Connection failed: ' + result.error, 'error', 8000);
            }
        }

        /**
         * Validates the add-connection form and returns a structured INIT job.
         *
         * @returns {object} structured McdataJob
         */
        function buildInitJob() {
            const projectRoot = globalObject.McState.get().projectRoot;
            if (!projectRoot) {
                throw new Error('Select and use a project folder first.');
            }
            const credential = credInput.value.trim();
            if (!credential) {
                throw new Error('Enter a credential name.');
            }
            const clientId = clientIdInput.value.trim();
            if (!clientId) {
                throw new Error('Enter the client ID.');
            }
            const clientSecret = clientSecretInput.value;
            if (!clientSecret) {
                throw new Error('Enter the client secret.');
            }
            const authUrl = authUrlInput.value.trim();
            if (!authUrl) {
                throw new Error('Enter the auth URL.');
            }
            const enterpriseId = eidInput.value.trim();
            if (!/^\d+$/.test(enterpriseId)) {
                throw new Error('Enter a numeric enterprise MID.');
            }
            return {
                kind: JOB_KIND.INIT,
                projectRoot,
                credential,
                clientId,
                clientSecret,
                authUrl,
                enterpriseId,
                overwrite: overwrite.input.checked,
            };
        }

        useButton.addEventListener('click', () => {
            const chosen = picker.input.value.trim();
            if (!chosen) {
                toast('Choose a folder first.', 'warn');
                return;
            }
            globalObject.McState.set({ projectRoot: chosen });
            // Persist so the folder is restored on the next app launch. Fire-and-
            // forget: a failure to persist must not block using the folder now.
            void globalObject.mcdata.setProjectRoot(chosen);
            toast('Project folder set.', 'success');
            refreshSaved();
        });

        openButton.addEventListener('click', async () => {
            const current = picker.input.value.trim() || globalObject.McState.get().projectRoot;
            if (!current) {
                toast('Choose a folder first.', 'warn');
                return;
            }
            const error = await globalObject.mcdata.openPath(current);
            if (error) {
                toast('Could not open folder: ' + error, 'error');
            }
        });

        saveButton.addEventListener('click', async () => {
            if (runner.isRunning) {
                return;
            }
            let job;
            try {
                job = buildInitJob();
            } catch (ex) {
                toast(ex?.message ?? String(ex), 'error');
                return;
            }
            saveButton.setAttribute('disabled', 'true');
            try {
                const outcome = await runner.start(job);
                if (outcome.ok) {
                    clientSecretInput.value = '';
                    await refreshSaved();
                }
            } finally {
                saveButton.removeAttribute('disabled');
            }
        });

        root.append(projectField, projectActions, savedSection, addSection);
        container.append(root);
        refreshSaved();
    }

    globalObject.McScreens ||= {};
    globalObject.McScreens.connections = { mount };
})(globalThis);
