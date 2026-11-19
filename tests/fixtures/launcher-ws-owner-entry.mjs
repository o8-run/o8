// Isolated fixture: production WS entry, auth, bridge and publication remain real.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.CORTEX_IDE_DATA_DIR;
if (!root || readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned launcher fixture required');
appendFileSync(join(root, 'ws-starts'), process.pid + '\n');
while (existsSync(join(root, 'hold-ws-start'))) await delay(20);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repo, 'src/ws-server.ts'));
const WebSocket = require('ws');
const emit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (name, ...args) {
  if (name === 'message') {
    try {
      const frame = JSON.parse(String(args[0]));
      if (frame.type === 'realtime-subscribe') appendFileSync(join(root, 'subscriptions.jsonl'), JSON.stringify({ pid: process.pid, frame }) + '\n');
    } catch { /* Other production frames are left alone. */ }
  }
  return emit.call(this, name, ...args);
};
process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = 'http://127.0.0.1:' + process.env.O8_API_PORT;
await import(pathToFileURL(join(repo, 'src/ws-server.ts')).href);
const publisher = await import(pathToFileURL(join(repo, 'src/lib/realtime/publisher.ts')).href);
const publish = publisher.publishRealtimeMutation ?? publisher.default.publishRealtimeMutation;
setInterval(() => { void publish({ mutation: { mutationId: 'launcher-producer-' + process.pid, source: 'server', action: 'launcher-fixture', status: 'completed', surfaceId: String(process.pid), createdAt: new Date().toISOString() } }); }, 250).unref();
