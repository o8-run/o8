#!/usr/bin/env node
// Offline provider: the HTTP route, stdin descriptor, spawn and stores are real.
import { appendFileSync, fstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log('claude-fixture 1.0.0');
} else {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const inputWait = setInterval(() => {}, 1000);
  const releaseInput = once(process, 'SIGUSR1');
  appendFileSync(join(root, 'launches.jsonl'), `${JSON.stringify({ pid: process.pid, stdinIsFile: fstatSync(0).isFile() })}\n`);
  // Let the test kill the launching server before the worker reads its payload.
  await releaseInput;
  clearInterval(inputWait);
  let payload = '';
  for await (const chunk of process.stdin) payload += chunk;
  writeFileSync(join(root, 'input.json'), payload);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '671d7c73-b85f-4489-90ec-05d95af4776a' }));
  let sequence = 0;
  const emit = (text) => console.log(JSON.stringify({ type: 'assistant',
    message: { id: `message-${++sequence}`, content: [{ type: 'text', text }] } }));
  const heartbeat = () => { emit(`heartbeat-${sequence}`); writeFileSync(join(root, 'heartbeat'), String(sequence)); };
  heartbeat();
  const timer = setInterval(heartbeat, 50);
  process.on('SIGUSR2', () => { emit(`offline-output:${'x'.repeat(256 * 1024)}`); writeFileSync(join(root, 'offline-written'), String(sequence)); });
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}
