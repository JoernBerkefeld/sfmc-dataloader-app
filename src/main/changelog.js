'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

/**
 * Allows only absolute HTTPS release-note links without embedded credentials.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeReleaseUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

const markdownRenderer = new MarkdownIt({ html: false }).disable('image');
markdownRenderer.validateLink = isSafeReleaseUrl;
markdownRenderer.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
};

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
 * Selects bundled release sections and renders Markdown with raw HTML and images disabled.
 *
 * @param {string} markdown
 * @param {string} currentVersion
 * @param {string | undefined} acknowledgedVersion
 * @returns {object}
 */
function selectChangelog(markdown, currentVersion, acknowledgedVersion) {
    const sections = markdown
        .matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*\n([\s\S]*?)(?=^## \[|$(?![\s\S]))/gm)
        .map((match) => ({
            version: match[1],
            text: match[2].trim(),
            html: markdownRenderer.render(match[2].trim()),
        }))
        .toArray();
    const current = sections.find((section) => section.version === currentVersion);
    const baseline = Number.isNaN(compareVersions(currentVersion, acknowledgedVersion))
        ? undefined
        : acknowledgedVersion;
    const summary = sections.filter(
        (section) =>
            compareVersions(section.version, currentVersion) <= 0 &&
            (baseline
                ? compareVersions(section.version, baseline) > 0
                : section.version === currentVersion),
    );
    return {
        currentVersion,
        pending: Boolean(current) && (!baseline || compareVersions(currentVersion, baseline) > 0),
        sections: summary,
        history: sections.filter(
            (section) =>
                compareVersions(section.version, currentVersion) <= 0 && !summary.includes(section),
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

module.exports = { compareVersions, selectChangelog, readBundledChangelog, isSafeReleaseUrl };
