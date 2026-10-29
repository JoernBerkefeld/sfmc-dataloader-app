'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const parseVersion = (value) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined;

/**
 * Compares stable app release versions without consulting the network.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) {
        return NaN;
    }
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) {
            return Math.sign(a[index] - b[index]);
        }
    }
    return 0;
}

/**
 * Selects bundled release sections; Markdown stays text, never executable HTML.
 *
 * @param {string} markdown
 * @param {string} currentVersion
 * @param {string | undefined} acknowledgedVersion
 * @returns {object}
 */
function selectChangelog(markdown, currentVersion, acknowledgedVersion) {
    const sections = markdown
        .matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*\n([\s\S]*?)(?=^## \[|$(?![\s\S]))/gm)
        .map((match) => ({ version: match[1], text: match[2].trim() }))
        .toArray();
    const current = sections.find((section) => section.version === currentVersion);
    const baseline = Number.isNaN(compareVersions(currentVersion, acknowledgedVersion))
        ? undefined
        : acknowledgedVersion;
    return {
        currentVersion,
        pending: Boolean(current) && (!baseline || compareVersions(currentVersion, baseline) > 0),
        sections: sections.filter(
            (section) =>
                compareVersions(section.version, currentVersion) <= 0 &&
                (baseline
                    ? compareVersions(section.version, baseline) > 0
                    : section.version === currentVersion),
        ),
        history: sections.filter(
            (section) => compareVersions(section.version, currentVersion) <= 0,
        ),
    };
}

/**
 * Loads only the application's fixed, offline changelog path. Missing content never blocks startup.
 *
 * @returns {Promise.<string>}
 */
async function readBundledChangelog() {
    try {
        return await fs.readFile(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
    } catch {
        return '';
    }
}

module.exports = { compareVersions, selectChangelog, readBundledChangelog };
