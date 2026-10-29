'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const locale = fs.readFileSync(
    path.join(__dirname, '../packaging/winget/JoernBerkefeld.SFMCDataLoader.locale.en-US.yaml'),
    'utf8',
);
const changelog = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8');

test('WinGet enriches the requested version, not newest or previous notes', async () => {
    const { enrichLocale } = await import('../scripts/winget-release-notes.mjs');
    for (const version of ['0.8.0', '0.8.1']) {
        const result = parse(
            enrichLocale(
                locale.replace('PackageVersion: 0.8.1', () => `PackageVersion: ${version}`),
                changelog,
                version,
            ),
        );
        assert.equal(result.PackageVersion, version);
        assert.ok(result.ReleaseNotes.length > 0);
        assert.equal(
            result.ReleaseNotesUrl,
            `https://github.com/JoernBerkefeld/sfmc-dataloader-app/releases/tag/v${version}`,
        );
        assert.equal(result.ReleaseNotes.includes('foreground contrast'), version === '0.8.1');
        assert.equal(result.ReleaseNotes.includes('Skip empty lines'), version === '0.8.0');
        assert.equal(result.Publisher, 'Joern Berkefeld');
    }
});

test('WinGet YAML safely round-trips multiline content and replaces stale fields', async () => {
    const { enrichLocale } = await import('../scripts/winget-release-notes.mjs');
    const notes =
        '### Fixed\n\n- Colon: # comment &alias *tag\n- "Quotes", \'apostrophes\', backslashes \\, $& and Unicode ü\n\n---\nPackageVersion: malicious\n  indented';
    const input = `${locale}\nReleaseNotes: |-\n  Previous notes\nReleaseNotesUrl: https://example.com/old\n`;
    const output = enrichLocale(
        input,
        `## [0.8.1] — today\r\n${notes.replaceAll('\n', '\r\n')}\r\n\r\n## [0.7.0]\r\nOld`,
        '0.8.1',
    );
    const result = parse(output);
    assert.equal(result.ReleaseNotes, notes);
    assert.equal(result.PackageVersion, '0.8.1');
    assert.equal((output.match(/^ReleaseNotes:/gm) ?? []).length, 1);
    assert.equal(enrichLocale(output, `## [0.8.1]\n${notes}`, '0.8.1'), output);
});

test('WinGet fails closed for missing, empty, duplicate, oversized or invalid release notes', async () => {
    const { releaseNotes, enrichLocale } = await import('../scripts/winget-release-notes.mjs');
    for (const input of [
        '',
        '## [0.8.1]\n\n',
        '## [0.8.1]\nOne\n## [0.8.1]\nTwo',
        `## [0.8.1]\n${'x'.repeat(10_001)}`,
    ]) {
        assert.throws(() => releaseNotes(input, '0.8.1'), /Expected one nonempty/);
    }
    assert.throws(() => releaseNotes(changelog, '0.8.1/escape'), /Invalid stable/);
    assert.throws(() => enrichLocale(locale, changelog, '0.8.0'), /Expected .*manifest/);
    assert.throws(
        () => enrichLocale(`${locale}\nPackageVersion: 0.8.1\n`, changelog, '0.8.1'),
        /Invalid locale YAML/,
    );
    assert.throws(
        () =>
            enrichLocale(
                locale.replace('ManifestType: defaultLocale', 'ManifestType: installer'),
                changelog,
                '0.8.1',
            ),
        /Expected .*manifest/,
    );
});

test('WinGet CLI reads explicitly release-bound notes instead of tooling checkout notes', () => {
    require('./fixtures/temporary-preflight').assertTemporaryEnvironment();
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-notes-'));
    const manifest = path.join(root, 'JoernBerkefeld.SFMCDataLoader.locale.en-US.yaml');
    const releaseChangelog = path.join(root, 'CHANGELOG.md');
    fs.writeFileSync(manifest, locale);
    fs.writeFileSync(releaseChangelog, '## [0.8.1]\nRelease-tag-bound notes.\n');
    const result = spawnSync(
        process.execPath,
        [
            path.join(__dirname, '../scripts/winget-release-notes.mjs'),
            root,
            '0.8.1',
            releaseChangelog,
        ],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parse(fs.readFileSync(manifest, 'utf8')).ReleaseNotes, 'Release-tag-bound notes.');
    // Only remove the exact files created by this test; no recursive cleanup.
    fs.unlinkSync(manifest);
    fs.unlinkSync(releaseChangelog);
    fs.rmdirSync(root);
});

test('local seed refresh also enriches locale after version replacement', () => {
    const script = fs.readFileSync(
        path.join(__dirname, '../scripts/update-packaging-manifests.mjs'),
        'utf8',
    );
    assert.match(script, /enrichLocale\(updated, changelog, version\)/);
    assert.ok(script.indexOf('PackageVersion:') < script.indexOf('enrichLocale(updated'));
});
