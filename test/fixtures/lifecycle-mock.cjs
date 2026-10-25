'use strict';

/* global require */

// Runs only in the isolated integration child: replace work, not lifecycle wiring.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
    const loaded = originalLoad.call(Module, name, parent, isMain);
    if (name.endsWith('/shared/run-mcdata-job.js')) {
        return {
            ...loaded,
            createJobRunner: (dependencies) =>
                loaded.createJobRunner({
                    ...dependencies,
                    importDataloader: async () => ({
                        main: async (argv) => {
                            // A live handle ensures natural event-loop draining cannot hide a leak.
                            setInterval(() => {}, 1000);
                            if (argv.includes('fatal')) {
                                setImmediate(() => {
                                    throw new Error('Mock fatal exception');
                                });
                                await new Promise(() => {});
                            }
                            if (argv.includes('rejection')) {
                                Promise.reject(new Error('Mock unhandled rejection'));
                                await new Promise(() => {});
                            }
                            if (argv.includes('failure')) {
                                throw new Error('Mock handled failure');
                            }
                            return 0;
                        },
                    }),
                }),
        };
    }
    return loaded;
};
