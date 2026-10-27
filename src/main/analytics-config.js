'use strict';

// Public ingestion configuration shared with vscode-sfmc-dataloader (project 254290).
// This is not a personal API key. No build secrets or generated credentials are used.
const BATCH_ENDPOINT = 'https://eu.i.posthog.com/batch/';
const PROJECT_API_KEY = 'phc_AY9WHA5c6M9QqkaapgPqSTZ2NNZK3L3FxwkbdASsS7Ex';

/**
 * Allows only the EU ingestion endpoint and a public project ingestion token.
 *
 * @returns {boolean}
 */
function isConfigured() {
    return (
        BATCH_ENDPOINT === 'https://eu.i.posthog.com/batch/' && PROJECT_API_KEY.startsWith('phc_')
    );
}

module.exports = { BATCH_ENDPOINT, PROJECT_API_KEY, isConfigured };
