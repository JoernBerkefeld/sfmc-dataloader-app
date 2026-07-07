'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, JOB_KIND } = require('../src/shared/channels');

const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
    'utf8',
);

/**
 * The sandboxed preload inlines the channel names because it cannot require a
 * local module. This test re-reads that inlined literal and asserts it stays in
 * lockstep with the canonical `src/shared/channels.js` map, so the two never
 * drift apart silently.
 */
test('preload inlined CHANNELS matches the shared source of truth', () => {
    for (const [key, value] of Object.entries(CHANNELS)) {
        const pattern = new RegExp(String.raw`${key}:\s*'${value}'`);
        assert.match(
            preloadSource,
            pattern,
            `preload must inline ${key}: '${value}' to match src/shared/channels.js`,
        );
    }
});

/**
 * JOB_KIND is inlined into the preload for the same sandbox reason and surfaced
 * to the renderer as `window.mcdata.JOB_KIND`. Guard it against drift too.
 */
test('preload inlined JOB_KIND matches the shared source of truth', () => {
    for (const [key, value] of Object.entries(JOB_KIND)) {
        const pattern = new RegExp(String.raw`${key}:\s*'${value}'`);
        assert.match(
            preloadSource,
            pattern,
            `preload must inline ${key}: '${value}' to match src/shared/channels.js`,
        );
    }
});
