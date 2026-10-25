'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertTemporaryEnvironment } = require('./fixtures/temporary-preflight');
const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

test(String.raw`local temp validation retains strict normalized F:\Temp enforcement`, () => {
    assertTemporaryEnvironment({
        platform: 'win32',
        tmpdir: 'F:\\Temp\\',
        environment: { TEMP: 'f:/temp', TMP: 'F:\\TEMP\\' },
    });
    for (const tmpdir of ['D:', 'D:\\', 'F:\\', 'Temp', String.raw`C:\Temp`]) {
        assert.throws(() =>
            assertTemporaryEnvironment({
                platform: 'win32',
                tmpdir,
                environment: { TEMP: tmpdir },
            }),
        );
    }
    for (const environment of [
        {},
        { TEMP: String.raw`F:\Temp`, TMP: String.raw`C:\Temp` },
        { TEMP: 'relative' },
    ]) {
        assert.throws(() =>
            assertTemporaryEnvironment({
                platform: 'win32',
                tmpdir: String.raw`F:\Temp`,
                environment,
            }),
        );
    }
});
test('only the complete GitHub-hosted selector allows native runner temp', () => {
    for (const environment of [
        { GITHUB_ACTIONS: 'true' },
        { RUNNER_ENVIRONMENT: 'github-hosted' },
        { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
        { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' },
    ]) {
        assert.throws(() =>
            assertTemporaryEnvironment({
                platform: 'win32',
                tmpdir: String.raw`C:\runner\temp`,
                environment: { ...environment, TEMP: String.raw`C:\runner\temp` },
            }),
        );
    }
    for (const [platform, tmpdir, variables] of [
        ['linux', '/tmp', {}],
        ['darwin', '/var/folders/runner/T/', { TMPDIR: '/var/folders/runner/T/' }],
        [
            'win32',
            String.raw`C:\Users\runner\Temp`,
            { TEMP: 'c:/users/runner/temp/', TMP: String.raw`C:\Users\runner\Temp` },
        ],
    ]) {
        assertTemporaryEnvironment({ platform, tmpdir, environment: { ...hosted, ...variables } });
    }
});
test('hosted temp validation rejects roots, relative paths and conflicting variables', () => {
    for (const [platform, tmpdir] of [
        ['linux', '/'],
        ['linux', 'tmp'],
        ['win32', 'C:'],
        ['win32', 'C:\\'],
    ]) {
        assert.throws(() => assertTemporaryEnvironment({ platform, tmpdir, environment: hosted }));
    }
    for (const variables of [
        { TEMP: '/elsewhere' },
        { TMP: 'relative' },
        { TMPDIR: '/TMP' },
        { TEMP: '/' },
    ]) {
        assert.throws(() =>
            assertTemporaryEnvironment({
                platform: 'linux',
                tmpdir: '/tmp',
                environment: { ...hosted, ...variables },
            }),
        );
    }
});
test('Windows temp paths must be fully qualified locally and on hosted runners', () => {
    for (const selector of [{}, hosted]) {
        for (const value of [String.raw`\Temp`, '/Temp']) {
            assert.throws(
                () =>
                    assertTemporaryEnvironment({
                        platform: 'win32',
                        tmpdir: value,
                        environment: { ...selector, TEMP: value },
                    }),
                /Temp paths must be fully qualified/u,
            );
            for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
                assert.throws(
                    () =>
                        assertTemporaryEnvironment({
                            platform: 'win32',
                            tmpdir: String.raw`F:\Temp`,
                            environment: { ...selector, TEMP: String.raw`F:\Temp`, [name]: value },
                        }),
                    /Temp paths must be fully qualified/u,
                );
            }
        }
    }
    assertTemporaryEnvironment({
        platform: 'win32',
        tmpdir: String.raw`\\server\share\Temp`,
        environment: { ...hosted, TEMP: '//server/share/temp/' },
    });
});
test('POSIX temp paths preserve literal trailing backslashes', () => {
    const literal = '/tmp\\';
    for (const platform of ['linux', 'darwin']) {
        assertTemporaryEnvironment({
            platform,
            tmpdir: literal,
            environment: { ...hosted, TEMP: literal },
        });
        assertTemporaryEnvironment({
            platform,
            tmpdir: '/tmp/',
            environment: { ...hosted, TEMP: '/tmp' },
        });
        for (const [tmpdir, value] of [
            ['/tmp', literal],
            [literal, '/tmp'],
        ]) {
            for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
                assert.throws(
                    () =>
                        assertTemporaryEnvironment({
                            platform,
                            tmpdir,
                            environment: { ...hosted, [name]: value },
                        }),
                    new RegExp(`${name} must match the OS temp directory`, 'u'),
                );
            }
        }
    }
});
test('Linux release tests use a virtual display without reducing the full suite', () => {
    const workflow = fs.readFileSync(
        path.join(__dirname, '../.github/workflows/build-release.yml'),
        'utf8',
    );
    assert.match(
        workflow,
        /run: xvfb-run -a npm test --no-workspaces\n\s+if: runner\.os == 'Linux'/u,
    );
    assert.match(workflow, /run: npm test --no-workspaces\n\s+if: runner\.os != 'Linux'/u);
});

test('release initializes Electron serially and configures the Linux sandbox before tests', () => {
    const workflow = fs.readFileSync(
        path.join(__dirname, '../.github/workflows/build-release.yml'),
        'utf8',
    );
    const initialization = workflow.indexOf('name: Initialize Electron before parallel tests');
    const sandbox = workflow.indexOf('name: Configure Linux Electron sandbox');
    const suite = workflow.indexOf('run: xvfb-run -a npm test --no-workspaces');
    assert.ok(initialization > workflow.indexOf('run: npm ci --no-workspaces'));
    assert.ok(sandbox > initialization && suite > sandbox);
    assert.match(
        workflow.slice(initialization, sandbox),
        /run: node -e "console\.log\(require\('electron'\)\)"/u,
    );
    const setup = workflow.slice(sandbox, suite);
    assert.match(setup, /if: runner\.os == 'Linux'\n\s+shell: bash/u);
    assert.ok(setup.includes('electron_path=$(node -p "require(\'electron\')")'));
    assert.ok(setup.includes('sandbox_path="$(dirname "$electron_path")/chrome-sandbox"'));
    assert.ok(
        setup.indexOf('sudo chown root:root "$sandbox_path"') <
            setup.indexOf('sudo chmod 4755 "$sandbox_path"'),
    );
    assert.match(setup, /sudo chmod 4755 "\$sandbox_path"/u);
    assert.doesNotMatch(workflow, /--no-sandbox|--disable-setuid-sandbox/u);
});
