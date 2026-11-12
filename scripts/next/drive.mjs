#!/usr/bin/env node
// Sends one request to a development o8 next window (native/o8-next/docs/driver.md).
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = `usage: node scripts/next/drive.mjs <command> [arguments] [--allow name]...
  snapshot [prefix]
  press <selector>
  scroll <selector> <dx> <dy>
  key "<keystrokes>"
  type "<text>"
socket: $O8_NEXT_DRIVER_SOCKET, else ~/.o8/next-driver.sock`;

const args = process.argv.slice(2);
const allow = [];
for (let index = args.indexOf('--allow'); index >= 0; index = args.indexOf('--allow')) {
  const [, name] = args.splice(index, 2);
  if (!name) { console.error(usage); process.exit(2); }
  allow.push(name);
}
const [command, ...rest] = args;
const shapes = {
  snapshot: ([prefix]) => ({ prefix: prefix ?? '' }),
  press: ([selector]) => ({ selector }),
  scroll: ([selector, dx, dy]) => ({ selector, dx: Number(dx ?? 0), dy: Number(dy ?? 0) }),
  key: ([keys]) => ({ keys }),
  type: ([text]) => ({ text }),
};
if (!shapes[command]) { console.error(usage); process.exit(2); }
const request = { command, ...shapes[command](rest), ...(allow.length ? { allow } : {}) };
const path = process.env.O8_NEXT_DRIVER_SOCKET || join(homedir(), '.o8', 'next-driver.sock');

const socket = connect(path);
let answer = '';
socket.setEncoding('utf8');
socket.setTimeout(15_000, () => { console.error('the window did not answer'); process.exit(1); });
socket.on('error', error => { console.error(`${path}: ${error.message}`); process.exit(1); });
socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
socket.on('data', chunk => {
  answer += chunk;
  const end = answer.indexOf('\n');
  if (end < 0) return;
  const line = answer.slice(0, end);
  socket.end();
  let ok = false;
  try { ok = JSON.parse(line).ok === true; } catch { /* print what came back */ }
  console.log(line);
  process.exit(ok ? 0 : 1);
});
