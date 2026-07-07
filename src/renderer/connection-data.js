'use strict';

// Renderer-side helpers that turn the saved project config into pick lists for
// the Export/Import screens, so low-tech users select a Business Unit and Data
// Extensions instead of hand-typing `credential/BU` tokens and customer keys.
// All privileged work goes through window.mcdata (loadConfig / fetchDeList).
// Exposed as the global `McConnectionData`.
(function initConnectionData(globalObject) {
    /**
     * Reads the saved connections and flattens them into `credential/BU`
     * options suitable for a <select>. Returns an empty list (never throws)
     * when nothing is configured yet.
     *
     * @param {string} projectRoot
     * @returns {Promise.<{value: string, label: string}[]>}
     */
    async function listCredBuOptions(projectRoot) {
        if (!projectRoot) {
            return [];
        }
        let result;
        try {
            result = await globalObject.mcdata.loadConfig(projectRoot);
        } catch {
            return [];
        }
        if (!result.configured) {
            return [];
        }
        const options = [];
        for (const cred of result.credentials) {
            for (const bu of cred.businessUnits) {
                const value = cred.credential + '/' + bu.name;
                options.push({ value, label: value + '  (MID ' + bu.mid + ')' });
            }
        }
        return options;
    }

    /**
     * Fetches the Data Extension list for a `credential/BU` token via a live
     * authenticated call. Splits the token and delegates to window.mcdata.
     *
     * @param {string} projectRoot
     * @param {string} credBu - `credential/BU`
     * @returns {Promise.<{ok: boolean, items?: {name: string, key: string}[], error?: string}>}
     */
    async function listDeItems(projectRoot, credBu) {
        const slash = credBu.indexOf('/');
        if (slash <= 0 || slash === credBu.length - 1) {
            return { ok: false, error: 'Choose a Business Unit first.' };
        }
        const credential = credBu.slice(0, slash);
        const bu = credBu.slice(slash + 1);
        try {
            return await globalObject.mcdata.fetchDeList({ projectRoot, credential, bu });
        } catch (ex) {
            return { ok: false, error: ex?.message ?? String(ex) };
        }
    }

    globalObject.McConnectionData = { listCredBuOptions, listDeItems };
})(globalThis);
