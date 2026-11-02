/** Isolated scheduler subprocess; native reads still use the production GET handlers. */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ root }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--scheduled')) return {};
  const state = join(root, 'scheduled-source.json');
  writeFileSync(state, JSON.stringify({ mode: 'ok' }));
  const binary = join(root, 'openclaw');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('OpenClaw 2026.9.2'); process.exit(0); }
if (args.join(' ') !== 'cron list --all --json') process.exit(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (state.mode === 'fail') process.exit(3);
process.stdout.write(JSON.stringify({ jobs: state.mode === 'empty' ? [] : [{
  id: 'fixture-nightly', name: 'Nightly review', agentId: 'default', enabled: true,
  schedule: { kind: 'cron', expr: '0 2 * * *' }, state: { lastRunStatus: 'ok' }
}] }));
`);
  chmodSync(binary, 0o700);
  process.env.O8_OPENCLAW_BIN = binary;
  process.env.O8_LOCAL_SCHEDULES = 'off';
  const local = await import('../../../src/app/api/automations/route');
  const connected = await import('../../../src/app/api/automations/connected/route');
  let lists = 0;
  return { priority: 10, routes: {
    'GET /api/automations': local.GET,
    'GET /api/automations/connected': async request => {
      lists++;
      return connected.GET(request);
    },
    'GET /api/scheduled-fixture': async request => {
      const mode = request.nextUrl.searchParams.get('mode');
      if (mode && ['ok', 'fail', 'empty'].includes(mode)) {
        writeFileSync(join(root, 'scheduled-source.json'), JSON.stringify({ mode }));
      }
      return Response.json({ lists });
    },
  } };
}
