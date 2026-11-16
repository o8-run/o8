#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\n');
  process.exit(0);
}

if (process.argv[2] !== 'app-server' || process.argv[3] !== '--stdio') {
  process.exit(2);
}

if (process.env.O8_CODEX_CAPACITY_AUDIT) {
  appendFileSync(process.env.O8_CODEX_CAPACITY_AUDIT, `${process.env.CODEX_HOME ?? ''}\n`, 'utf8');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  } else if (message.method === 'account/rateLimits/read') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 33, windowDurationMins: 10_080, resetsAt: 1_787_197_379 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: '120.5' },
        },
        rateLimitResetCredits: { availableCount: 3, credits: [] },
        planType: 'pro',
      },
    })}\n`);
  } else if (message.method === 'account/read') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro', workspaceName: 'Example Workspace' } },
    })}\n`);
  }
});
