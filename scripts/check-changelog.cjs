'use strict';
/* global require, module */

const { readBundledChangelog, selectChangelog } = require('../src/main/changelog');
const { version } = require('../package.json');

module.exports = async function checkChangelog() {
    const notes = selectChangelog(await readBundledChangelog(), version);
    if (!notes.pending) {
        throw new Error(`Bundled CHANGELOG.md must contain a release section for ${version}.`);
    }
};

async function main() {
    try {
        await module.exports();
    } catch (ex) {
        console.error(ex.message);
        process.exitCode = 1;
    }
}
if (require.main === module) {
    void main();
}
