'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { selectChangelog, compareVersions, readBundledChangelog } = require('../src/main/changelog');
const { SettingsStore } = require('../src/main/settings-store');

const markdown =
    '# Changelog\n\n## [2.0.0] — today\n\nCurrent <script>not HTML</script>\n\n## [1.1.0]\n\nMiddle\n\n## [1.0.0]\n\nOld\n';

test('offline release selection covers upgrades, skipped versions, legacy, relaunch and downgrades', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.ok(Number.isNaN(compareVersions('invalid', '1.0.0')));
    assert.deepEqual(
        selectChangelog(markdown, '2.0.0', '1.0.0').sections.map((s) => s.version),
        ['2.0.0', '1.1.0'],
    );
    assert.deepEqual(
        selectChangelog(markdown, '2.0.0').sections.map((s) => s.version),
        ['2.0.0'],
    );
    assert.equal(selectChangelog(markdown, '2.0.0', '2.0.0').pending, false);
    assert.equal(selectChangelog(markdown, '1.1.0', '2.0.0').pending, false);
    assert.equal(selectChangelog(markdown, '3.0.0', '1.0.0').pending, false);
    assert.equal(selectChangelog('', '2.0.0').pending, false);
    assert.match(selectChangelog(markdown, '2.0.0').sections[0].text, /<script>/);
});

test('fresh installs baseline silently; legacy notes persist until explicit acknowledgement', async () => {
    require('./fixtures/temporary-preflight').assertTemporaryEnvironment();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdata-changelog-'));
    const filePath = path.join(root, 'settings.json');
    const fresh = new SettingsStore({ filePath, currentVersion: '1.0.0' });
    await fresh.init();
    assert.equal(fresh.getChangelogAcknowledgement(), '1.0.0');
    await fs.writeFile(filePath, JSON.stringify({ projectRoot: 'F:/existing' }));
    const legacy = new SettingsStore({ filePath, currentVersion: '2.0.0' });
    await legacy.init();
    assert.equal(legacy.getChangelogAcknowledgement(), undefined);
    const relaunched = new SettingsStore({ filePath, currentVersion: '2.0.0' });
    await relaunched.init();
    assert.equal(relaunched.getChangelogAcknowledgement(), undefined);
    relaunched._writeFile = async () => {
        throw new Error('unavailable');
    };
    const failed = await relaunched.acknowledgeChangelog();
    assert.equal(failed.saved, false);
    assert.equal(relaunched.getChangelogAcknowledgement(), undefined);
    relaunched._writeFile = fs.writeFile;
    const saved = await relaunched.acknowledgeChangelog();
    assert.equal(saved.saved, true);
    const downgraded = new SettingsStore({ filePath, currentVersion: '1.1.0' });
    await downgraded.init();
    await downgraded.acknowledgeChangelog();
    assert.equal(downgraded.getChangelogAcknowledgement(), '2.0.0');
    const upgraded = new SettingsStore({ filePath, currentVersion: '3.0.0' });
    await upgraded.init();
    assert.equal(upgraded.getChangelogAcknowledgement(), '2.0.0');
});

test('bundled history and packaging guard are available offline', async () => {
    const { version } = require('../package.json');
    const content = await readBundledChangelog();
    assert.ok(selectChangelog(content, version).pending);
    await require('../scripts/check-changelog.cjs')();
    const config = await fs.readFile(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    assert.match(config, /- CHANGELOG\.md/);
    assert.match(config, /beforePack: scripts\/check-changelog.cjs/);
});
