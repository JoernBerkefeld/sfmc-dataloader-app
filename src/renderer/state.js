'use strict';

// Tiny shared app state for the renderer. The project root is the working
// directory sfmc-dataloader reads `.mcdatarc.json` / `.mcdata-auth.json` from,
// and every job is scoped to it. Screens read/write this single value so
// switching tabs keeps the chosen project. Exposed as the global `McState`.
(function initState(globalObject) {
    const listeners = new Set();

    const state = {
        /** @type {string} absolute path to the project root, or '' */
        projectRoot: '',
    };

    /**
     * @param {Partial<typeof state>} patch
     * @returns {void}
     */
    function set(patch) {
        Object.assign(state, patch);
        for (const listener of listeners) {
            listener(state);
        }
    }

    /**
     * @param {(next: typeof state) => void} listener
     * @returns {() => void} unsubscribe
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    globalObject.McState = {
        get: () => state,
        set,
        subscribe,
    };
})(globalThis);
