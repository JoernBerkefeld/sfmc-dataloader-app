'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * Validates this machine's fixed temp location or a hosted runner's native temp.
 * This grants no cleanup authorization and never changes the environment.
 *
 * @param {object} [options]
 * @param options.environment
 * @param options.tmpdir
 * @param options.platform
 * @returns {void}
 */
function assertTemporaryEnvironment({
    environment = process.env,
    tmpdir = os.tmpdir(),
    platform = process.platform,
} = {}) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const normalize = (value) => {
        assert.equal(typeof value, 'string');
        assert.ok(paths.isAbsolute(value), 'Temp paths must be absolute');
        if (platform === 'win32') {
            assert.ok(
                !/^[\\/]$/u.test(paths.parse(value).root),
                'Temp paths must be fully qualified',
            );
        }
        const resolved = paths.resolve(value);
        assert.notEqual(resolved, paths.parse(resolved).root, 'Temp paths must not be roots');
        const trimmed = resolved.replace(platform === 'win32' ? /[\\/]+$/u : /\/+$/u, '');
        return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    };
    const isHosted =
        environment.GITHUB_ACTIONS === 'true' && environment.RUNNER_ENVIRONMENT === 'github-hosted';
    const actual = normalize(tmpdir);
    if (!isHosted) {
        assert.equal(platform, 'win32', 'Local verification requires this Windows machine');
        assert.equal(actual, String.raw`f:\temp`);
        assert.equal(normalize(environment.TEMP), actual);
    }
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
        const value = environment[name];
        if (value) {
            assert.equal(normalize(value), actual, `${name} must match the OS temp directory`);
        }
    }
}

module.exports = { assertTemporaryEnvironment };
