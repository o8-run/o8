#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChannel } from './lib/build-channel.mjs';
import { runShipWorkflow } from './lib/ship-broadcast.mjs';
const root = process.cwd();
try {
  const version = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).version;
  const identity = buildChannel(root, version);
  if (identity.channel === 'stable')
    throw new Error('Normal ship requires a candidate build.');
  await runShipWorkflow({
    root,
    version,
    publisher:
      identity.channel === 'preview' ? 'release.mjs' : 'release-beta.mjs',
  });
} catch {
  console.error(
    '[ship] Candidate ship failed; inspect build and publication checks.',
  );
  process.exitCode = 1;
}
