// Test-process instrumentation only: a stand-in for a pending macOS privacy
// prompt. Until the prompt is answered, every filesystem call on a path under
// O8_PROMPT_FOLDER blocks its thread on a FIFO open, as the real prompt does:
// a synchronous call blocks the event loop, an asynchronous one holds a libuv
// pool thread. Opening the FIFO for writing answers the prompt; the parked
// calls then run.
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const folder = process.env.O8_PROMPT_FOLDER;
const fifo = process.env.O8_PROMPT_FIFO;
if (!folder || !fifo) throw new Error('Missing prompt folder or FIFO');
const openSync = fs.openSync;
const open = fs.open;
let answered = false;

const blocked = (value) => {
  if (answered) return false;
  if (value instanceof URL) value = value.pathname;
  if (Buffer.isBuffer(value)) value = value.toString();
  return typeof value === 'string' && (value === folder || value.startsWith(`${folder}/`));
};
const waitSync = () => {
  fs.closeSync(openSync(fifo, 'r'));
  answered = true;
};
const park = (resume) => open(fifo, 'r', (error, fd) => {
  if (!error) { answered = true; fs.close(fd, () => {}); }
  resume();
});

for (const name of Object.keys(fs)) {
  const fn = fs[name];
  if (typeof fn !== 'function' || /^[A-Z]/.test(name) || ['open', 'openSync', 'close', 'closeSync'].includes(name)) continue;
  const sync = /Sync$/.test(name) || ['watch', 'watchFile', 'createReadStream', 'createWriteStream'].includes(name);
  fs[name] = function (...args) {
    if (!args.slice(0, 2).some(blocked)) return fn.apply(this, args);
    if (sync) { waitSync(); return fn.apply(this, args); }
    park(() => fn.apply(this, args));
    return undefined;
  };
  Object.defineProperties(fs[name], Object.getOwnPropertyDescriptors(fn));
}
for (const name of Object.keys(fs.promises)) {
  const fn = fs.promises[name];
  if (typeof fn !== 'function') continue;
  fs.promises[name] = function (...args) {
    if (!args.slice(0, 2).some(blocked)) return fn.apply(this, args);
    return new Promise((resolve, reject) => park(() => fn.apply(this, args).then(resolve, reject)));
  };
}
for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
  const fn = cp[name];
  cp[name] = function (...args) {
    const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
    if (blocked(options?.cwd) || (Array.isArray(args[1]) && args[1].some(blocked))) waitSync();
    return fn.apply(this, args);
  };
  Object.defineProperties(cp[name], Object.getOwnPropertyDescriptors(fn));
}
syncBuiltinESMExports();
