// Keep registry parsing, pinned-package validation, staging and the native
// supervisor real; replace only catalog network I/O and the npm executable.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.env.CORTEX_IDE_DATA_DIR;
process.env.O8_PI_WRITE_BIN = path.resolve('crates/o8d/target/debug/o8-pi-write');
delete process.env.O8_ACP_COMMAND;
const installer = path.join(root, 'fixture-registry-installer.cjs');
fs.writeFileSync(installer, `
const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(${JSON.stringify(path.join(root, 'fixture-installer-pid'))}, String(process.pid));
const args = process.argv.slice(2), stage = args[args.indexOf('--prefix') + 1];
if (!args.includes('fixture-agent@1.0.0') || !args.includes('--ignore-scripts')) process.exit(2);
if (fs.existsSync(${JSON.stringify(path.join(root, 'fixture-fail'))})) process.exit(1);
const pkg = path.join(stage, 'node_modules/fixture-agent'); fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-agent', version: '1.0.0', bin: 'agent.js' }));
fs.writeFileSync(path.join(pkg, 'agent.js'), '#!/usr/bin/env node\\n');
`);
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (args?.[0] === 'supervise' && args.includes('fixture-agent@1.0.0')) {
    const child = spawn.call(this, command, [...args.slice(0, 2), process.execPath, installer, ...args.slice(3)], options);
    fs.writeFileSync(path.join(root, 'fixture-supervisor-pid'), String(child.pid));
    return child;
  }
  return spawn.call(this, command, args, options);
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => String(input) === 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
  ? Promise.resolve(Response.json({ agents: [{ id: 'fixture-agent', name: 'Fixture agent', version: '1.0.0',
    distribution: { npx: { package: 'fixture-agent@1.0.0', args: [] } } }] })) : fetch(input, options);
