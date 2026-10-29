'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/code-test.yml'),
    'utf8',
);
const packageJson = require('../package.json');
const builder = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/build-release.yml'),
    'utf8',
);

const wingetWorkflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/winget-publish.yml'),
    'utf8',
);

test('winget has reusable and WinGet-only manual triggers with an explicit tag', () => {
    assert.match(
        wingetWorkflow,
        / {4}workflow_call:\n {8}inputs:\n {12}release-tag:\n {16}required: true\n {16}type: string\n {8}secrets:\n {12}WINGET_TOKEN:\n {16}required: false\n/,
    );
    assert.match(wingetWorkflow, /workflow_dispatch:\n {8}inputs:\n {12}release-tag:/);
    assert.doesNotMatch(wingetWorkflow, /^ {4}(?:release|workflow_run):/m);
    assert.doesNotMatch(
        wingetWorkflow,
        /electron-builder|build-release\.yml|update-packaging-manifests/,
    );
    assert.doesNotMatch(wingetWorkflow, /github\.event\.release\.tag_name/);
    assert.doesNotMatch(wingetWorkflow, /--submit/);
    assert.equal((wingetWorkflow.match(/wingetcreate\.exe submit/g) ?? []).length, 1);
});

test('winget caller waits for the complete successful installer matrix', () => {
    const caller = releaseWorkflow.match(/^ {4}winget:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1];
    assert.ok(caller, 'winget caller must exist');
    assert.match(caller, /^ {8}needs: build$/m);
    assert.match(caller, /if: \$\{\{ !github\.event\.release\.prerelease \}\}/);
    assert.match(caller, /uses: \.\/\.github\/workflows\/winget-publish\.yml/);
    assert.match(caller, /with:\n {12}release-tag: \$\{\{ github\.event\.release\.tag_name \}\}/);
    assert.match(caller, /secrets:\n {12}WINGET_TOKEN: \$\{\{ secrets\.WINGET_TOKEN \}\}/);
    assert.doesNotMatch(caller, /always\(|continue-on-error:/);
    assert.equal(
        (releaseWorkflow.match(/uses: \.\/\.github\/workflows\/winget-publish\.yml/g) ?? []).length,
        1,
    );
    const build = releaseWorkflow.split('    winget:', 1)[0];
    assert.match(build, /fail-fast: false/);
    for (const platform of ['win', 'mac', 'linux']) {
        assert.ok(build.includes(`platform: ${platform}`));
    }
    const publish = build.match(
        /- name: Build & publish \(\$\{\{ matrix\.platform \}\}\)\n([\s\S]*?)(?= {12}# snap)/,
    )?.[1];
    assert.ok(publish, 'required installer upload step must exist');
    assert.doesNotMatch(publish, /continue-on-error:|\|\|\s*true/);
});

test('winget preserves stable-only submission and successful absent-token skip', () => {
    assert.match(wingetWorkflow, /if: \$\{\{ !github\.event\.release\.prerelease \}\}/);
    assert.match(wingetWorkflow, /WINGET_TOKEN: \$\{\{ secrets\.WINGET_TOKEN \}\}/);
    const skip = wingetWorkflow.indexOf('if (-not $env:WINGET_TOKEN) {');
    assert.ok(skip !== -1);
    assert.match(
        wingetWorkflow.slice(skip),
        /^if \(-not \$env:WINGET_TOKEN\) \{\n[^\n]*Write-Host[^\n]*\n[^\n]*exit 0\n[^\n]*\}/,
    );
    assert.ok(skip < wingetWorkflow.indexOf('Invoke-WebRequest'));
});

test('winget checks the exact release EXE before downloading or submitting wingetcreate', () => {
    assert.match(wingetWorkflow, /RELEASE_TAG: \$\{\{ inputs\.release-tag \}\}/);
    assert.ok(wingetWorkflow.includes("$version = $env:RELEASE_TAG.TrimStart('v')"));
    assert.ok(
        wingetWorkflow.includes(
            'releases/download/$env:RELEASE_TAG/sfmc-dataloader-app-$version-win-x64.exe',
        ),
    );
    const check = wingetWorkflow.indexOf('Invoke-WebRequest -Uri $installerUrl -Method Head');
    const download = wingetWorkflow.indexOf(
        "Invoke-WebRequest -Uri 'https://aka.ms/wingetcreate/latest'",
    );
    const submit = wingetWorkflow.indexOf(String.raw`.\wingetcreate.exe update`);
    assert.ok(check !== -1 && download > check && submit > download);
});

test('winget propagates download, asset-check and native submission failures', () => {
    assert.ok(wingetWorkflow.includes("$ErrorActionPreference = 'Stop'"));
    assert.ok(wingetWorkflow.includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
    assert.match(
        wingetWorkflow,
        /--token \$env:WINGET_TOKEN\n[^\n]*if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/,
    );
    assert.doesNotMatch(wingetWorkflow, /continue-on-error:|\|\|\s*true|catch\s*\{/);
    assert.equal((wingetWorkflow.match(/exit 0/g) ?? []).length, 1);
});

test('winget enriches release-bound generated manifests before submitting that same directory', () => {
    assert.match(wingetWorkflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(wingetWorkflow, /ref: \$\{\{ inputs\.release-tag \}\}\n {18}path: release-source/);
    assert.match(wingetWorkflow, /node-version-file: package.json/);
    assert.match(wingetWorkflow, /npm ci --no-workspaces/);
    assert.match(wingetWorkflow, /--out \$output/);
    assert.ok(wingetWorkflow.includes('manifests/j/JoernBerkefeld/SFMCDataLoader/$version'));
    const generate = wingetWorkflow.indexOf('wingetcreate.exe update');
    const enrich = wingetWorkflow.indexOf(
        'node scripts/winget-release-notes.mjs $manifestDirectory $version release-source/CHANGELOG.md',
    );
    const submit = wingetWorkflow.indexOf('wingetcreate.exe submit $manifestDirectory');
    assert.ok(generate < enrich && enrich < submit);
    assert.match(
        wingetWorkflow.slice(enrich, submit),
        /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/,
    );
});

test('manual winget retry authenticates and fails closed for unavailable or unstable releases', () => {
    assert.match(wingetWorkflow, /permissions:\n {4}contents: read/);
    assert.match(wingetWorkflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(
        wingetWorkflow,
        /gh release view .*--repo JoernBerkefeld\/sfmc-dataloader-app --json isDraft,isPrerelease\n[^\n]*if \(\$LASTEXITCODE -ne 0\)/,
    );
    assert.ok(
        wingetWorkflow.includes('$release.isDraft -ne $false -or $release.isPrerelease -ne $false'),
    );
    assert.ok(
        wingetWorkflow.indexOf('gh release view') <
            wingetWorkflow.indexOf('wingetcreate.exe update'),
    );
});

test('manifest refresh installs its YAML dependency before running the packaging script', () => {
    const refreshJob = releaseWorkflow.split('    update-manifests:', 2)[1];
    assert.ok(refreshJob, 'manifest refresh job must exist');
    const setup = refreshJob.indexOf('uses: actions/setup-node@');
    const install = refreshJob.indexOf('run: npm ci --no-workspaces');
    const refresh = refreshJob.indexOf('run: node scripts/update-packaging-manifests.mjs');
    assert.ok(setup !== -1 && install > setup && refresh > install);
});

test('Linux CI initializes Electron and configures its sandbox before Xvfb tests', () => {
    const steps = workflow.split(/^ {12}- /m).slice(1);
    const install = steps.findIndex((step) => step.includes('run: npm ci --no-workspaces'));
    const lint = steps.findIndex((step) => step.includes('run: npm run lint'));
    const initialize = steps.findIndex((step) =>
        step.includes('run: node -e "console.log(require(\'electron\'))"'),
    );
    const sandbox = steps.findIndex((step) => step.includes('sudo chown root:root'));
    const tests = steps.findIndex((step) =>
        step.includes('run: xvfb-run -a npm test --no-workspaces'),
    );

    assert.ok(install !== -1 && lint > install);
    assert.ok(initialize > lint && sandbox > initialize && tests > sandbox);
    assert.match(steps[sandbox], /shell: bash/);
    assert.ok(steps[sandbox].includes('electron_path=$(node -p "require(\'electron\')")'));
    assert.ok(steps[sandbox].includes('sandbox_path="$(dirname "$electron_path")/chrome-sandbox"'));
    assert.ok(steps[sandbox].includes('sudo chown root:root "$sandbox_path"'));
    assert.ok(steps[sandbox].includes('sudo chmod 4755 "$sandbox_path"'));
    assert.ok(steps[sandbox].indexOf('sudo chown') < steps[sandbox].indexOf('sudo chmod'));
    for (const index of [initialize, sandbox, tests]) {
        assert.doesNotMatch(steps[index], /\bif:|continue-on-error:|\|\|\s*true/);
    }
});

test('macOS builds retain DMGs and add updater ZIPs for both architectures', () => {
    const mac = builder.match(/^mac:\n([\s\S]*?)(?=^\S)/m)?.[1];
    assert.ok(mac, 'macOS builder configuration must exist');
    const targets = mac
        .matchAll(/^ {8}- target: (\w+)\n {10}arch:\n((?: {14}- \w+\n)+)/gm)
        .toArray();
    assert.deepEqual(
        targets.map(([, target, architectures]) => ({
            target,
            arch: architectures
                .matchAll(/- (\w+)/g)
                .map(([, arch]) => arch)
                .toArray(),
        })),
        [
            { target: 'dmg', arch: ['x64', 'arm64'] },
            { target: 'zip', arch: ['x64', 'arm64'] },
        ],
    );
    assert.ok(mac.includes('artifactName: ${name}-${version}-mac-${arch}.${ext}'));
    assert.match(builder, /directories:\n {4}output: release\n/);
    assert.match(builder, /^ {4}- '!node_modules\/sfmc-sdk\/scripts\/prepare-release\.mjs'$/m);
    assert.doesNotMatch(builder, /!node_modules\/sfmc-sdk\/(?:\*|lib\/)/);
});

test('release publishing uses configured macOS targets and GitHub update metadata', () => {
    const macRunner = releaseWorkflow.match(/- os: macos-latest\n([\s\S]*?)(?= {20}- os:)/)?.[1];
    assert.ok(macRunner, 'native macOS runner must exist');
    assert.match(macRunner, /platform: mac\n/);
    assert.match(macRunner, /buildArgs: --mac\n/);
    assert.doesNotMatch(macRunner, /buildArgs:.*(?:dmg|zip|--x64|--arm64)/);
    assert.ok(
        releaseWorkflow.includes(
            'run: npx electron-builder ${{ matrix.buildArgs }} --publish always',
        ),
    );
    assert.match(releaseWorkflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(
        builder,
        /^publish:\n {4}provider: github\n {4}owner: JoernBerkefeld\n {4}repo: sfmc-dataloader-app\n {4}releaseType: release\n?$/m,
    );
});

test('Linux CI preserves the Node matrix and the full parallel sandboxed test suite', () => {
    assert.match(workflow, /runs-on: ubuntu-latest/);
    assert.match(workflow, /fail-fast: false/);
    assert.match(workflow, /node: \[22, 24, 25\]/);
    assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/);
    assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
    assert.equal((workflow.match(/npm test/g) ?? []).length, 1);
    assert.doesNotMatch(
        workflow,
        /--no-sandbox|--disable-setuid-sandbox|ELECTRON_DISABLE_SANDBOX|--test-concurrency|--test-name-pattern|--test-skip-pattern/,
    );
});
