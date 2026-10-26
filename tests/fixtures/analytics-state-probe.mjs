import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server.js';

const load = async (file) => {
  const imported = await import(pathToFileURL(resolve(file)).href);
  return imported.default ?? imported;
};
const { POST } = await load('src/app/api/runtime/launch/route.ts');
const settings = await load('src/app/api/panel/operator-defaults/route.ts');
const { getRuntime } = await load('src/lib/runtimes/index.ts');
const lifecycle = await load('src/lib/analytics/session.ts');
const root = join(process.env.O8_DATA_DIR, 'usage-analytics');
let sequence = 0;
let egress = 0;
getRuntime('cloud').launch = async () => ({
  ok: true, sessionKey: `cloud:state-probe-${++sequence}`, note: 'Fixture launched.',
});
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/v1/telemetry')) egress++;
  return Response.json({ ok: true });
};
const choose = async (enabled) => {
  const response = await settings.POST(new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST', body: JSON.stringify({ productTelemetryEnabled: enabled,
      crashReportsEnabled: false, telemetryConsentAnswered: true }),
  }));
  if (response.status !== 200) throw new Error('Fixture settings save failed.');
};
const launch = async () => (await POST(new NextRequest('http://localhost/api/runtime/launch', {
  method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Fixture', cwd: process.env.O8_DATA_DIR,
    skipSetup: true, isolate: false, clientMutationId: `state-probe-${process.pid}-${++sequence}` }),
}))).status;

function forbidStateAccess(accesses) {
  const originals = [];
  for (const api of [fs, fs.promises]) {
    for (const name of ['access', 'exists', 'stat', 'lstat', 'realpath', 'readdir', 'opendir', 'open', 'readFile', 'writeFile',
      'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'truncate', 'watch'].flatMap((name) => [name, `${name}Sync`])) {
      if (typeof api[name] !== 'function') continue;
      const original = api[name];
      originals.push([api, name, original]);
      api[name] = Object.assign(function (...args) {
        if (args.slice(0, 2).some((value) => typeof value === 'string' && (value === root || value.startsWith(root + sep)))) {
          accesses.push(name);
          throw new Error('Analytics state access while off.');
        }
        return original.apply(this, args);
      }, original);
    }
  }
  syncBuiltinESMExports();
  return () => {
    for (const [api, name, original] of originals.reverse()) api[name] = original;
    syncBuiltinESMExports();
  };
}

function snapshot() {
  return fs.existsSync(root) ? JSON.stringify(fs.readdirSync(root).sort().map((name) => [
    name, fs.readFileSync(join(root, name), 'utf8'),
  ])) : null;
}

const notify = (type) => new Promise((resolve, reject) => {
  process.send({ type }, (error) => error ? reject(error) : resolve());
});
const admitted = new Promise((resolve) => process.once('message', (message) => {
  if (message?.type !== 'run') throw new Error('Fixture readiness acknowledgement is missing.');
  resolve();
}));
await notify('ready');
await admitted;

const results = [];
if (process.argv[2] === 'off') {
  const cases = [
    ...['launch', 'startup'].flatMap((entry) => [false, true].map((existing) => ({ entry, existing }))),
    { entry: 'shutdown', existing: true },
  ];
  for (const item of cases) {
    fs.rmSync(root, { recursive: true, force: true });
    await choose(false);
    if (item.existing) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(join(root, 'sentinel'), 'unchanged');
      fs.writeFileSync(join(root, 'session-2147483647.json'), JSON.stringify({ pid: 2147483647, enabled: true }));
    }
    if (item.entry === 'shutdown') {
      await choose(true);
      await lifecycle.startProductSession();
      await choose(false);
    }
    const before = snapshot();
    const accesses = [];
    const restore = forbidStateAccess(accesses);
    egress = 0;
    let status = 200;
    await notify('case_started');
    try {
      if (item.entry === 'launch') status = await launch();
      else {
        if (item.entry === 'startup') await lifecycle.startProductSession();
        await lifecycle.endProductSession(true);
      }
    } finally { restore(); }
    results.push({ ...item, status, accesses, egress, unchanged: snapshot() === before });
    await notify('case_completed');
  }
} else if (process.argv[2] === 'markers') {
  let markerScans = 0;
  const readdir = fs.readdirSync;
  fs.readdirSync = function (path, ...args) {
    if (String(path) === root) markerScans++;
    return readdir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  for (const enabled of [false, true]) {
    for (const kind of ['regular', 'fifo', 'directory']) {
      fs.rmSync(root, { recursive: true, force: true });
      await choose(enabled);
      fs.mkdirSync(root, { recursive: true });
      const marker = join(root, `session-${process.ppid}.json`);
      if (kind === 'fifo') execFileSync('mkfifo', [marker]);
      else if (kind === 'directory') fs.mkdirSync(marker);
      else fs.writeFileSync(marker, JSON.stringify({ pid: process.ppid, enabled: !enabled }));
      egress = 0;
      markerScans = 0;
      await notify('case_started');
      const status = await launch();
      results.push({ enabled, kind, status, markerScans, egress,
        regularUpdated: enabled && kind === 'regular' ? JSON.parse(fs.readFileSync(marker, 'utf8')).enabled : null });
      await notify('case_completed');
    }
  }
} else throw new Error('Unknown fixture mode.');

await new Promise(resolve => process.stdout.write(`ANALYTICS_STATE_PROBE:${JSON.stringify(results)}\n`, resolve));
process.exit(0);
