import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const pidFile = process.env.SYMON_MCP_PID_FILE;
const exitFile = process.env.SYMON_MCP_EXIT_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
// Records only whether a fixture sentinel credential reached this process, never the environment itself.
if (process.env.SYMON_MCP_SENTINEL_FILE) {
  writeFileSync(process.env.SYMON_MCP_SENTINEL_FILE, String(Object.values(process.env).some((value) => value?.includes('o8-fixture-sentinel'))));
}

let exiting = false;
function exit(signal) {
  if (exiting) return;
  exiting = true;
  if (exitFile) appendFileSync(exitFile, `${process.pid}:${signal}\n`);
  input.close();
  process.stdin.destroy();
}

process.on('SIGTERM', () => exit('SIGTERM'));
process.on('SIGINT', () => exit('SIGINT'));

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'symon-fixture', version: '1.0.0' },
      },
    })}\n`);
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Return the supplied fixture value.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          { name: 'collision?', inputSchema: { type: 'object' } },
          { name: 'collision@', inputSchema: { type: 'object' } },
        ],
      },
    })}\n`);
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'echo') {
    if (request.params?.arguments?.value === 'fixture-error') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: 'untrusted fixture error '.repeat(100) },
      })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: String(request.params?.arguments?.value ?? '') }],
        structuredContent: { echo: request.params?.arguments?.value ?? null },
      },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: 'Unknown fixture method' },
  })}\n`);
});
