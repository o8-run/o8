// Fixture-only observations of the real producer's admission, never credentials.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const root = process.env.CORTEX_IDE_DATA_DIR;
if (!root || readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned Settings fixture required');
const rename = files.rename;
files.rename = async function (from, to) {
  const result = await rename.call(this, from, to);
  if ([join(root, 'settings.toml'), join(root, 'operator-defaults.json')].includes(String(to))) {
    appendFileSync(join(root, 'settings-node-writes.jsonl'), JSON.stringify({ file: String(to).endsWith('.toml') ? 'toml' : 'json' }) + '\n');
  }
  return result;
};
syncBuiltinESMExports();
const identity = await import('../../src/lib/panel/instance-identity.ts');
const cold = {
  cached: identity.peekCachedInstanceIdentity(),
  persisted: existsSync(join(root, 'instance-id')),
};
// A real override in the producer, absent from o8d's curated environment.
if (existsSync(join(root, 'settings-env-override'))) process.env.O8_BRANCH_PREFIX = 'fixture-env/';
const writeHead = ServerResponse.prototype.writeHead;
ServerResponse.prototype.writeHead = function (...args) {
  if (this.req.url?.startsWith('/api/panel/operator-defaults') && this.req.headers['x-o8d-session-read'] === 'authorize') {
    const headers = args.at(-1);
    const encoded = headers?.['x-o8d-defaults-context'];
    if (encoded) {
      const context = JSON.parse(Buffer.from(encoded, 'base64').toString());
      appendFileSync(join(root, 'settings-admissions.jsonl'), JSON.stringify({
        machineMatchesLauncher: context.machineId === process.env.O8_INSTANCE_ID,
        machineMatchesFile: context.machineId === readFileSync(join(root, 'instance-id'), 'utf8').trim(),
        operatorEnvClean: context.operatorEnvClean,
      }) + '\n');
    }
  }
  return writeHead.apply(this, args);
};
await import('./launcher-ws-owner-entry.mjs');
writeFileSync(join(root, 'settings-identity.json'), JSON.stringify({
  cold,
  warmMatchesLauncher: identity.peekCachedInstanceIdentity()?.instanceId === process.env.O8_INSTANCE_ID,
  warmMatchesFile: identity.peekCachedInstanceIdentity()?.instanceId === readFileSync(join(root, 'instance-id'), 'utf8').trim(),
}));
