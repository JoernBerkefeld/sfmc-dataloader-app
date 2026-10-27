'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Analytics } = require('../src/main/analytics');

/**
 * A fake settings store exposing just the two accessors Analytics uses.
 *
 * @param {object} options
 * @param {string} [options.clientId]
 * @param {boolean | undefined} [options.consent]
 * @returns {{ getClientId: () => string, getConsent: () => (boolean | undefined) }}
 */
function fakeSettings({ clientId = 'client-1', consent = true } = {}) {
    return {
        getClientId: () => clientId,
        getConsent: () => consent,
        getConsentRevision: () => 0,
    };
}

/**
 * A configured analytics-config double so isConfigured() is true by default.
 *
 * @param {boolean} [isConfigured]
 * @returns {{ BATCH_ENDPOINT: string, PROJECT_API_KEY: string, isConfigured: () => boolean }}
 */
function fakeConfig(isConfigured = true) {
    return {
        BATCH_ENDPOINT: 'https://eu.i.posthog.com/batch/',
        PROJECT_API_KEY: isConfigured ? 'phc_test_public_ingestion' : '',
        isConfigured: () => isConfigured,
    };
}

/**
 * Records fetch calls and resolves immediately so the fire-and-forget path runs.
 *
 * @returns {{calls: {url: string, options: object}[], fetch: (url: string, options: object) => Promise.<object>}}
 */
function recordingFetch() {
    const calls = [];
    return {
        calls,
        fetch(url, options) {
            calls.push({ url, options });
            return Promise.resolve({ ok: true });
        },
    };
}

/**
 * Builds an Analytics wired to a synchronous scheduler so scheduled sends run
 * inline and can be asserted without waiting on setImmediate.
 *
 * @param {object} overrides
 * @returns {{analytics: Analytics, fetchCalls: object[], scheduled: () => void[]}}
 */
function makeAnalytics(overrides = {}) {
    const { fetch, calls } = recordingFetch();
    const scheduled = [];
    const analytics = new Analytics({
        settings: overrides.settings ?? fakeSettings(),
        appVersion: '1.2.3',
        loaderVersion: overrides.loaderVersion,
        locale: overrides.locale ?? 'en-US',
        enabled: overrides.enabled ?? true,
        config: overrides.config ?? fakeConfig(),
        fetch: overrides.fetch ?? fetch,
        // Synchronous scheduler: run the deferred send immediately so tests can
        // assert on it, while still proving track* defers via _schedule.
        schedule:
            overrides.schedule ??
            ((callback) => {
                scheduled.push(callback);
            }),
        runtime: overrides.runtime ?? { platform: 'win32', arch: 'x64', env: {} },
        osVersion: overrides.osVersion ?? '10.0.22631',
    });
    return { analytics, fetchCalls: calls, scheduled };
}

/**
 * Drains the pending scheduled callbacks (the deferred sends).
 *
 * @param {() => void[]} scheduled
 * @returns {void}
 */
function flush(scheduled) {
    while (scheduled.length > 0) {
        const callback = scheduled.shift();
        callback();
    }
}

test('parity events use the shared consent gate and never replay preconsent operations', () => {
    let isConsent = false;
    let revision = 0;
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: {
            getConsent: () => isConsent,
            getConsentRevision: () => revision,
            getClientId: () => 'random-client',
        },
    });
    const before = analytics.beginOperation();
    analytics.trackLoaderVersion();
    isConsent = true;
    analytics.trackActionOutcome({ action: 'de_discovery', result: 'success' }, before);
    const accepted = analytics.beginOperation();
    analytics.trackActionOutcome(
        {
            action: 'de_discovery',
            result: 'error',
            errorCategory: 'discovery_failed',
            errorName: 'SECRET',
            errorCode: 'F:/SECRET',
        },
        accepted,
    );
    analytics.trackLoaderVersion();
    flush(scheduled);
    assert.equal(fetchCalls.length, 2);
    const bodies = fetchCalls.map((call) => JSON.parse(call.options.body).batch[0]);
    assert.deepEqual(
        bodies.map((item) => item.event),
        ['action_outcome', 'loader_version'],
    );
    assert.equal(JSON.stringify(bodies).includes('SECRET'), false);
    assert.equal(bodies[1].properties.loader_version, 'unknown');
    revision++;
    analytics.trackActionOutcome({ action: 'config_load', result: 'success' }, accepted);
    flush(scheduled);
    assert.equal(fetchCalls.length, 2);
});

test('resolved loader version is shaped without exposing a source path', () => {
    const { analytics, scheduled, fetchCalls } = makeAnalytics({ loaderVersion: '3.2.0' });
    analytics.trackLoaderVersion();
    flush(scheduled);
    assert.equal(
        JSON.parse(fetchCalls[0].options.body).batch[0].properties.loader_version,
        '3.2.0',
    );
});

for (const overrides of [
    { enabled: false },
    { settings: fakeSettings({ consent: false }) },
    { settings: { ...fakeSettings(), getConsent: () => {} } },
]) {
    test(`new parity events remain disabled for ${JSON.stringify(overrides)}`, () => {
        const { analytics, scheduled, fetchCalls } = makeAnalytics(overrides);
        analytics.trackLoaderVersion();
        analytics.trackActionOutcome(
            { action: 'config_load', result: 'success' },
            analytics.beginOperation(),
        );
        flush(scheduled);
        assert.equal(fetchCalls.length, 0);
    });
}

test('isActive is false when disabled (dev build)', () => {
    const { analytics } = makeAnalytics({ enabled: false });
    assert.equal(analytics.isActive(), false);
});

test('isActive is false when ingestion is not configured', () => {
    const { analytics } = makeAnalytics({ config: fakeConfig(false) });
    assert.equal(analytics.isActive(), false);
});

test('isActive is true when enabled and configured', () => {
    const { analytics } = makeAnalytics();
    assert.equal(analytics.isActive(), true);
});

test('trackLifecycle returns synchronously and defers the POST', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('launch');

    // Nothing sent yet — the send was only scheduled, never run inline. This is
    // the non-blocking guarantee: track* never touches the network on its tick.
    assert.equal(fetchCalls.length, 0);
    assert.equal(scheduled.length, 1);

    flush(scheduled);
    assert.equal(fetchCalls.length, 1);
});

test('first consenting run sends an honest event AND app_launch, never app_install', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('first-consented-run');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).batch[0].event);
    assert.deepEqual(names, ['app_first_consented_run', 'app_launch']);
});

test('update lifecycle sends app_update AND app_launch', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('update');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).batch[0].event);
    assert.deepEqual(names, ['app_update', 'app_launch']);
});

test('plain launch sends only app_launch', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).batch[0].event);
    assert.deepEqual(names, ['app_launch']);
});

test('lifecycle events are not sent or queued after a decline', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ consent: false }),
    });

    analytics.trackLifecycle('install');
    assert.equal(scheduled.length, 0);
    flush(scheduled);

    assert.equal(fetchCalls.length, 0);
});

test('optional usage events are dropped without opt-in consent', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: { ...fakeSettings(), getConsent: () => {} },
    });

    analytics.trackExport({ format: 'csv', deCount: 3 });
    analytics.trackImport({ format: 'csv', deCount: 1 });
    analytics.trackJobOutcome({ kind: 'export', result: 'success' });
    flush(scheduled);

    assert.equal(fetchCalls.length, 0);
});

test('optional usage events fire when consent is granted', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ consent: true }),
    });

    analytics.trackExport({ format: 'csv', deCount: 3, multiBu: false });
    flush(scheduled);

    assert.equal(fetchCalls.length, 1);
    const payload = JSON.parse(fetchCalls[0].options.body);
    assert.equal(payload.batch[0].event, 'export_used');
    assert.equal(payload.batch[0].properties.de_count_bucket, '2-5');
    assert.equal(payload.batch[0].properties.locale, 'en');
});

test('nothing is sent when disabled, regardless of consent', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        enabled: false,
        settings: fakeSettings({ consent: true }),
    });

    analytics.trackLifecycle('install');
    analytics.trackExport({ format: 'csv', deCount: 1 });
    flush(scheduled);

    assert.equal(fetchCalls.length, 0);
    assert.equal(scheduled.length, 0);
});

test('a missing client id blocks the send', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ clientId: '', consent: true }),
    });

    analytics.trackLifecycle('launch');
    flush(scheduled);

    assert.equal(fetchCalls.length, 0);
});

test('the POST targets PostHog EU without credentials in the URL', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const { url, options } = fetchCalls[0];
    assert.equal(url, 'https://eu.i.posthog.com/batch/');
    assert.equal(JSON.parse(options.body).api_key, 'phc_test_public_ingestion');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.ok(options.signal, 'a timeout AbortSignal must be attached');
});

test('the payload uses random clientId as distinct_id, app identity and no person profiles', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ clientId: 'abc-123' }),
    });

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const payload = JSON.parse(fetchCalls[0].options.body);
    assert.deepEqual(
        Object.keys(payload).toSorted((a, b) => a.localeCompare(b)),
        ['api_key', 'batch'],
    );
    const item = payload.batch[0];
    assert.deepEqual(
        Object.keys(item).toSorted((a, b) => a.localeCompare(b)),
        ['event', 'properties', 'timestamp'],
    );
    assert.equal(item.properties.distinct_id, 'abc-123');
    assert.equal(item.properties.app, 'sfmc-dataloader-app');
    assert.equal(item.properties.$process_person_profile, false);
    assert.equal(new Date(item.timestamp).toISOString(), item.timestamp);
    assert.deepEqual(
        Object.keys(item.properties).toSorted((a, b) => a.localeCompare(b)),
        [
            '$process_person_profile',
            'app',
            'app_version',
            'arch',
            'distinct_id',
            'install_channel',
            'os',
            'os_version',
        ],
    );
});

test('a throwing fetch never propagates out of a track call', () => {
    const { analytics, scheduled } = makeAnalytics({
        fetch: () => {
            throw new Error('fetch unavailable');
        },
    });

    analytics.trackLifecycle('launch');
    // The synchronous throw happens inside the scheduled callback; draining it
    // must not throw, proving errors are swallowed.
    assert.doesNotThrow(() => flush(scheduled));
});

test('a rejected fetch promise is swallowed', async () => {
    const { analytics, scheduled } = makeAnalytics({
        fetch: () => Promise.reject(new Error('offline')),
    });

    analytics.trackLifecycle('launch');
    assert.doesNotThrow(() => flush(scheduled));
    // Give the swallowed rejection a tick to settle without an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
});

test('pending events are never scheduled or replayed after consent', () => {
    const state = { consent: undefined };
    const settings = { ...fakeSettings(), getConsent: () => state.consent };
    const { analytics, scheduled, fetchCalls } = makeAnalytics({ settings });
    analytics.trackLifecycle('install');
    analytics.trackExport({ format: 'csv', deCount: 1 });
    analytics.trackImport({ format: 'csv', deCount: 1 });
    analytics.trackJobOutcome({ kind: 'export', result: 'success' });
    assert.equal(scheduled.length, 0);
    state.consent = true;
    flush(scheduled);
    assert.equal(fetchCalls.length, 0);
    analytics.trackLifecycle('launch');
    flush(scheduled);
    assert.equal(fetchCalls.length, 1);
});

test('withdrawal drops queued events, including after a rapid re-opt-in', () => {
    let isConsent = true;
    let revision = 0;
    const settings = {
        ...fakeSettings(),
        getConsent: () => isConsent,
        getConsentRevision: () => revision,
    };
    const { analytics, scheduled, fetchCalls } = makeAnalytics({ settings });
    analytics.trackLifecycle('launch');
    analytics.trackExport({ format: 'csv', deCount: 1 });
    isConsent = false;
    revision++;
    flush(scheduled);
    assert.equal(fetchCalls.length, 0);
    isConsent = true;
    analytics.trackLifecycle('launch');
    analytics.clearPending();
    revision++;
    flush(scheduled);
    assert.equal(fetchCalls.length, 0);
    analytics.trackLifecycle('launch');
    revision++;
    flush(scheduled);
    assert.equal(fetchCalls.length, 0);
});

test('the default scheduler is setImmediate (real deferral, not inline)', async () => {
    const { fetch, calls } = recordingFetch();
    const analytics = new Analytics({
        settings: fakeSettings({ clientId: 'c', consent: true }),
        appVersion: '1.0.0',
        enabled: true,
        config: fakeConfig(),
        fetch,
        runtime: { platform: 'linux', arch: 'x64', env: {} },
        osVersion: '6.0',
        // no schedule override → real setImmediate
    });

    analytics.trackLifecycle('launch');
    // Still nothing on this tick.
    assert.equal(calls.length, 0);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
});

test('withdrawal aborts active requests and invalidates queued payloads', () => {
    const signals = [];
    const { analytics, scheduled } = makeAnalytics({
        fetch: (_url, options) => {
            signals.push(options.signal);
            return new Promise(() => {});
        },
    });
    analytics.trackLifecycle('launch');
    flush(scheduled);
    analytics.trackExport({ format: 'csv', deCount: 1 });
    analytics.clearPending();
    assert.equal(signals[0].aborted, true);
    flush(scheduled);
    assert.equal(signals.length, 1);
});

test('shutdown is immediate even if fetch ignores abort, and permanently disables sends', () => {
    let signal;
    const { analytics, scheduled } = makeAnalytics({
        fetch: (_url, options) => {
            signal = options.signal;
            return new Promise(() => {});
        },
    });
    analytics.trackLifecycle('launch');
    flush(scheduled);
    analytics.trackLifecycle('launch');
    assert.equal(analytics.dispose(), undefined);
    assert.equal(signal.aborted, true);
    assert.equal(analytics.isActive(), false);
    flush(scheduled);
    analytics.trackLifecycle('launch');
    assert.equal(scheduled.length, 0);
    assert.doesNotThrow(() => analytics.dispose());
});

test('every usage payload has only the safe event contract despite sensitive extra input', () => {
    const { analytics, scheduled, fetchCalls } = makeAnalytics();
    const sensitive = {
        path: 'F:/private/customer.csv',
        deName: 'Customers',
        buId: '1234567',
        error: 'password=secret',
        credentials: { secret: 'private' },
        extension: 'inventory',
        $process_person_profile: true,
    };
    analytics.trackExport({ ...sensitive, format: sensitive.path, deCount: 4 });
    analytics.trackImport({ ...sensitive, format: 'csv', deCount: 1, mode: sensitive.path });
    analytics.trackJobOutcome({ ...sensitive, kind: sensitive.path, result: sensitive.error });
    flush(scheduled);
    const contracts = [
        ['app_version', 'format', 'de_count_bucket', 'multi_bu', 'locale'],
        [
            'app_version',
            'format',
            'de_count_bucket',
            'file_count_bucket',
            'size_bucket',
            'mode',
            'cross_bu',
            'locale',
        ],
        ['app_version', 'kind', 'result', 'row_count_bucket', 'duration_bucket', 'locale'],
    ];
    for (const [index, call] of fetchCalls.entries()) {
        const properties = JSON.parse(call.options.body).batch[0].properties;
        assert.deepEqual(
            Object.keys(properties).toSorted((a, b) => a.localeCompare(b)),
            [...contracts[index], 'distinct_id', 'app', '$process_person_profile'].toSorted(
                (a, b) => a.localeCompare(b),
            ),
        );
        assert.equal(properties.$process_person_profile, false);
        assert.equal(properties.app, 'sfmc-dataloader-app');
        for (const value of ['Customers', '1234567', 'password=', 'customer.csv', 'inventory']) {
            assert.equal(call.options.body.includes(value), false);
        }
    }
});

test('request timeout aborts a hung transport after five seconds', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const { analytics, scheduled } = makeAnalytics({
        fetch: (_url, options) => {
            signal = options.signal;
            return new Promise((resolve) =>
                signal.addEventListener('abort', resolve, { once: true }),
            );
        },
    });
    analytics.trackLifecycle('launch');
    flush(scheduled);
    assert.equal(signal.aborted, false);
    context.mock.timers.tick(5000);
    assert.equal(signal.aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
});

test('deferred dispatch rechecks strict consent even without a revision change', () => {
    let consent = true;
    const { analytics, scheduled, fetchCalls } = makeAnalytics({
        settings: { ...fakeSettings(), getConsent: () => consent },
    });
    analytics.trackLifecycle('launch');
    consent = false;
    flush(scheduled);
    assert.equal(fetchCalls.length, 0);
    consent = 'true';
    analytics.trackLifecycle('launch');
    assert.equal(scheduled.length, 0);
});

test('release and packaging cannot inject or ship legacy GA4 credentials', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const workflow = fs.readFileSync(
        path.join(root, '.github/workflows/build-release.yml'),
        'utf8',
    );
    const packaging = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    const config = fs.readFileSync(path.join(root, 'src/main/analytics-config.js'), 'utf8');
    assert.doesNotMatch(workflow, /GA4_|write-analytics-config|Inject analytics config/);
    assert.match(packaging, /!src\/main\/analytics-config\.generated\.json/);
    assert.doesNotMatch(config, /readFile|analytics-config\.generated/);
    assert.equal(fs.existsSync(path.join(root, 'scripts/write-analytics-config.mjs')), false);
});

test('public configuration matches the read-only extension ingestion contract', () => {
    const config = require('../src/main/analytics-config');
    assert.equal(config.BATCH_ENDPOINT, 'https://eu.i.posthog.com/batch/');
    assert.equal(config.PROJECT_API_KEY, 'phc_AY9WHA5c6M9QqkaapgPqSTZ2NNZK3L3FxwkbdASsS7Ex');
    assert.equal(config.isConfigured(), true);
    assert.equal('API_SECRET' in config, false);
    assert.equal('MEASUREMENT_ID' in config, false);
});
