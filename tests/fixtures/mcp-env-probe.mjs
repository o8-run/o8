// Minimal stdio MCP server that records the credential-relevant environment it
// was launched with, then answers initialize/tools-list so the Symon catalog
// completes. Used by tests/mcp-launch-payer-real-path.test.ts (#4694): a
// configured MCP server must never receive o8's saved provider key unless its
// runtime is explicitly API-billed.
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';

const out = process.env.MCP_ENV_PROBE_OUT;
if (out) {
  const credentialNames = Object.keys(process.env).filter((name) => /API_KEY|TOKEN|SECRET|ANTHROPIC|OPENAI|O8_MASTER_KEY/i.test(name));
  writeFileSync(out, JSON.stringify({
    anthropic: process.env.ANTHROPIC_API_KEY ?? null,
    masterKey: process.env.O8_MASTER_KEY ?? null,
    // Every value the child can actually see, so the test can assert the saved
    // secret did not arrive under any name (exact-value match).
    values: Object.values(process.env).filter((value) => typeof value === 'string'),
    credentialNames,
  }));
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-probe', version: '1.0.0' } } })}\n`);
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'noop', inputSchema: { type: 'object' } }] } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unused' } })}\n`);
});
