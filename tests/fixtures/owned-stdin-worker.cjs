const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, mode] = process.argv.slice(2);
const file = name => path.join(root, name);
fs.writeFileSync(file('provider.json'), JSON.stringify({ pid: process.pid, stdinIsFile: fs.fstatSync(0).isFile() }));
if (mode === 'reject') {
  // A provider can claim success after closing input early. Transport failure
  // must still win in both the exit callback and a fresh server's reconciliation.
  console.log('complete');
  process.exit(0);
}
if (mode === 'stop-tree') {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000);"], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
  });
  child.once('message', () => fs.writeFileSync(file('descendant.json'), JSON.stringify({ pid: child.pid })));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    fs.writeFileSync(file('stop-requested'), signal);
    const timer = setInterval(() => {
      if (!fs.existsSync(file('release-stop'))) return;
      clearInterval(timer);
      child.once('exit', () => { fs.writeFileSync(file('tree-stopped'), 'stopped'); process.exit(0); });
      child.kill('SIGTERM');
    }, 20);
  });
  process.stdin.resume();
  return;
}
const chunks = [];
let bytes = 0;
let first = true;
process.stdin.on('data', chunk => {
  chunks.push(chunk);
  bytes += chunk.length;
  if (first) {
    first = false;
    process.stdin.pause();
    fs.writeFileSync(file('mid-write'), String(bytes));
  }
});
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  // Keep heartbeats running while the receipt is open but incomplete.
  const receipt = fs.openSync(file('received.json'), 'w', 0o600);
  setTimeout(() => {
    fs.writeFileSync(receipt, JSON.stringify({ bytes, sha256: crypto.createHash('sha256').update(input).digest('hex') }));
    fs.closeSync(receipt);
    console.log('complete');
  }, 500);
});
let ticks = 0;
const timer = setInterval(() => {
  fs.writeFileSync(file('heartbeat'), String(++ticks));
  if (mode.startsWith('reject-mid') && fs.existsSync(file('continue'))) {
    fs.writeFileSync(file('rejected.json'), JSON.stringify({ bytes }));
    fs.writeSync(2, 'provider final stderr' + (mode.endsWith('newline') ? '\n' : ''));
    fs.writeSync(1, 'complete\n');
    process.exit(0);
  }
  if (fs.existsSync(file('continue'))) process.stdin.resume();
  if (fs.existsSync(file('exit'))) { clearInterval(timer); process.exit(0); }
}, 20);
setTimeout(() => process.exit(9), 25_000).unref();
