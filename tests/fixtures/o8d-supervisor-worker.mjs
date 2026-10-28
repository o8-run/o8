#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log('codex-cli 1.0.0');
} else if (process.argv[2] === 'app-server') {
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line); if (!message.id) return;
    const result = message.method === 'model/list' ? { data: [{ model: 'gpt-5.4', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
      : message.method === 'config/read' ? { config: {} } : {};
    console.log(JSON.stringify({ id: message.id, result }));
  }).on('close', () => process.exit(0));
} else {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'supervisor-fixture-thread' }));
  let sequence = 0;
  const timer = setInterval(() => {
    if (sequence === 0 || !existsSync(join(process.env.O8_RESTART_FIXTURE_ROOT, 'parity'))) {
      console.log(JSON.stringify({ type: 'item.completed', item: {
        id: `output-${++sequence}`, type: 'agent_message', text: `fixture-output-${sequence}`,
      } }));
    }
    if (existsSync(join(process.env.O8_RESTART_FIXTURE_ROOT, 'finish'))) {
      clearInterval(timer);
      if (existsSync(join(process.env.O8_RESTART_FIXTURE_ROOT, 'drain'))) {
        const script = `const fs = require('node:fs'); const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(join(process.env.O8_RESTART_FIXTURE_ROOT, 'drained'))})) {
            clearInterval(timer); console.log('fixture-drained-output');
          }
        }, 40);`;
        const stdio = readFileSync(join(process.env.O8_RESTART_FIXTURE_ROOT, 'drain'), 'utf8') === 'closed' ? 'ignore' : 'inherit';
        spawn(process.execPath, ['-e', script], { stdio }).unref();
      }
      console.error('fixture-stderr');
      process.exitCode = 7;
    }
  }, 40);
}
