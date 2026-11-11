// Isolate executable discovery and the public release feed. The updater, child
// process, installer reservation, receipt and stream transport remain production.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HOME;
const bin = path.join(root, '.local/bin');
const versions = path.join(root, '.local/share/claude/versions');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(versions, { recursive: true });
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
fs.writeFileSync(path.join(root, '.claude/settings.json'), '{"autoUpdatesChannel":"stable"}');
const program = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log(path.basename(__filename)); }
else if (process.argv[2] === 'update') {
  fs.writeFileSync(path.join(process.env.HOME, 'fixture-installer-pid'), String(process.pid));
  setTimeout(() => {
    const next = path.join(path.dirname(__filename), '2.0.2');
    fs.copyFileSync(__filename, next); fs.chmodSync(next, 0o700);
    const launcher = path.join(process.env.HOME, '.local/bin/claude');
    fs.unlinkSync(launcher); fs.symlinkSync(next, launcher);
  }, 1000);
} else { process.exitCode = 2; }
`;
const initial = path.join(versions, '2.0.1');
fs.writeFileSync(initial, program, { mode: 0o700 });
try { fs.symlinkSync(initial, path.join(bin, 'claude')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
process.env.PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
for (const name of ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN', 'CLAUDE_CONFIG_DIR']) delete process.env[name];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => String(input).startsWith('https://downloads.claude.ai/claude-code-releases/')
  ? Promise.resolve(new Response('2.0.2')) : originalFetch(input, options);
// The fixture installation has no running sessions. Keep unrelated operator
// processes out of its external inventory; the installer child still runs.
const cp = require('node:child_process');
const execFile = cp.execFile;
cp.execFile = function(command, args, options, callback) {
  if (command === '/bin/ps' && args?.join(' ') === '-axo comm=,args=') {
    return execFile.call(this, process.execPath, ['-e', ''], options, callback);
  }
  return execFile.call(this, command, args, options, callback);
};
