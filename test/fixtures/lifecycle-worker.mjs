// Load mocked orchestration dependencies before the real production worker wiring.
import './lifecycle-mock.cjs';
await import('../../src/worker/worker.mjs');
