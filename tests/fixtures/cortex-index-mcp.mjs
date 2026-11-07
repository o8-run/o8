#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  const respond = result => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  if (request.method === 'initialize') respond({ protocolVersion: '2024-11-05' });
  if (request.method === 'tools/call') {
    const timer = setInterval(() => {
      if (!existsSync(join(process.env.CORTEX_IDE_DATA_DIR, 'finish-index'))) return;
      clearInterval(timer);
      respond({ content: [{ type: 'text', text: 'Fixture index complete' }] });
    }, 20);
  }
});
