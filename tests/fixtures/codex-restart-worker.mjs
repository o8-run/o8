#!/usr/bin/env node
// Offline provider substitute. The launch route, spawn, files and lane are real.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log('codex-cli 1.0.0');
} else if (process.argv[2] === 'app-server') {
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line); if (!message.id) return;
    const result = message.method === 'model/list' ? { data: [{ model: 'gpt-6.1-sol', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
      : message.method === 'config/read' ? { config: {} } : {};
    console.log(JSON.stringify({ id: message.id, result }));
  }).on('close', () => process.exit(0));
} else {
  const root = process.env.O8_RESTART_FIXTURE_ROOT;
  appendFileSync(join(root, 'launches.jsonl'), `${JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })}\n`);
  writeFileSync(join(root, 'worker.pid'), String(process.pid));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'restart-fixture-provider-session' }));
  let sequence = 0;
  const emit = () => {
    const text = `restart-heartbeat-${++sequence}`;
    console.log(JSON.stringify({ type: 'item.completed', item: { id: `message-${sequence}`, type: 'agent_message', text } }));
    writeFileSync(join(root, 'heartbeat'), String(sequence));
  };
  emit();
  const timer = setInterval(emit, 40);
  // Exceed pipe capacity while the server is absent; file-backed stdout must drain.
  process.on('SIGUSR2', () => {
    console.log(JSON.stringify({ type: 'item.completed', item: { id: `offline-output-${sequence}`, type: 'agent_message', text: `offline-output:${'x'.repeat(256 * 1024)}` } }));
    writeFileSync(join(root, 'offline-written'), 'complete');
  });
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}
