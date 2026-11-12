import { createRequire } from 'node:module';
await import('../../scripts/register-server-only-stub.mjs');
await import('tsx');
createRequire(import.meta.url)('./ws-parity-task-dispatch.cjs').registerRuntimeLoader();
await import('../../src/lib/mcp/operator-mcp-server.ts');
