// Explicit sequencing keeps the fixture resolver ahead of tsx in the async hook chain.
import { createRequire } from 'node:module';
await import('../../scripts/register-server-only-stub.mjs');
await import('tsx');
createRequire(import.meta.url)('./ws-parity-task-dispatch.cjs').registerRuntimeLoader();
await import('../../src/ws-server.ts');
