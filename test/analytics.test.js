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
function fakeSettings({ clientId = 'client-1', consent } = {}) {
    return {
        getClientId: () => clientId,
        getConsent: () => consent,
    };
}

/**
 * A configured analytics-config double so isConfigured() is true by default.
 *
 * @param {boolean} [isConfigured]
 * @returns {{ MP_ENDPOINT: string, MEASUREMENT_ID: string, API_SECRET: string, isConfigured: () => boolean }}
 */
function fakeConfig(isConfigured = true) {
    return {
        MP_ENDPOINT: 'https://example.test/mp/collect',
        MEASUREMENT_ID: isConfigured ? 'G-TEST' : '',
        API_SECRET: isConfigured ? 'secret' : '',
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

test('isActive is false when disabled (dev build)', () => {
    const { analytics } = makeAnalytics({ enabled: false });
    assert.equal(analytics.isActive(), false);
});

test('isActive is false when ids were not injected', () => {
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

test('install lifecycle sends app_install AND app_launch', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('install');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).events[0].name);
    assert.deepEqual(names, ['app_install', 'app_launch']);
});

test('update lifecycle sends app_update AND app_launch', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('update');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).events[0].name);
    assert.deepEqual(names, ['app_update', 'app_launch']);
});

test('plain launch sends only app_launch', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const names = fetchCalls.map((call) => JSON.parse(call.options.body).events[0].name);
    assert.deepEqual(names, ['app_launch']);
});

test('lifecycle events fire even without consent', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ consent: false }),
    });

    analytics.trackLifecycle('launch');
    flush(scheduled);

    assert.equal(fetchCalls.length, 1);
});

test('optional usage events are dropped without opt-in consent', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ consent: undefined }),
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
    assert.equal(payload.events[0].name, 'export_used');
    assert.equal(payload.events[0].params.de_count_bucket, '2-5');
    assert.equal(payload.events[0].params.locale, 'en');
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

test('the POST targets the configured EU endpoint with credentials in the query', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics();

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const { url, options } = fetchCalls[0];
    assert.match(url, /^https:\/\/example\.test\/mp\/collect\?/);
    assert.match(url, /measurement_id=G-TEST/);
    assert.match(url, /api_secret=secret/);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.ok(options.signal, 'a timeout AbortSignal must be attached');
});

test('the payload carries client_id, non_personalized_ads and a session id', () => {
    const { analytics, fetchCalls, scheduled } = makeAnalytics({
        settings: fakeSettings({ clientId: 'abc-123' }),
    });

    analytics.trackLifecycle('launch');
    flush(scheduled);

    const payload = JSON.parse(fetchCalls[0].options.body);
    assert.equal(payload.client_id, 'abc-123');
    assert.equal(payload.non_personalized_ads, true);
    assert.ok(payload.events[0].params.session_id);
    assert.equal(payload.events[0].params.engagement_time_msec, 1);
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
