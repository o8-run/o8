import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateCliCache } from '@/lib/runtimes/shared/cli-resolver';

const auth = vi.hoisted(() => ({ denied: false }));
const local = vi.hoisted(() => ({ jobs: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/automations/local-schedules', () => ({ readLocalSchedules: async () => local.jobs }));
vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => auth.denied ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : null,
}));

import { GET, PATCH } from './route';

let root: string;
let statePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-connected-cron-'));
  statePath = join(root, 'jobs.json');
  const binary = join(root, 'openclaw');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('OpenClaw 2026.9.2'); process.exit(0); }
const path = ${JSON.stringify(statePath)};
const jobs = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[0] !== 'cron') process.exit(2);
if (args[1] === 'list') { process.stdout.write(JSON.stringify({ jobs: args.includes('--all') ? jobs : jobs.filter((job) => job.enabled) })); process.exit(0); }
const job = jobs.find((entry) => entry.id === args[2]);
if (!job) process.exit(3);
if (args[1] === 'enable' || args[1] === 'disable') {
  job.enabled = args[1] === 'enable';
  fs.writeFileSync(path, JSON.stringify(jobs));
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
process.exit(4);
`);
  chmodSync(binary, 0o700);
  writeFileSync(statePath, JSON.stringify([{
    id: '82ac2f70-5549-4827-8974-adf5519decf5',
    name: 'Daily planning check-in',
    agentId: 'wedding',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 11 * * *', tz: 'America/New_York' },
    state: { nextRunAtMs: 1790175600000, lastRunAtMs: 1790089200030, lastRunStatus: 'ok' },
    payload: { message: 'private prompt must never leave this process' },
  }]));
  process.env.O8_OPENCLAW_BIN = binary;
  invalidateCliCache('openclaw-cron');
  auth.denied = false;
  local.jobs = [];
});

afterEach(() => {
  delete process.env.O8_OPENCLAW_BIN;
  invalidateCliCache('openclaw-cron');
  rmSync(root, { recursive: true, force: true });
});

function request(method: 'GET' | 'PATCH', body?: object): NextRequest {
  return new NextRequest('http://localhost/api/automations/connected', {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

it('lists the actual schedule and status without leaking the private prompt', async () => {
  const response = await GET(request('GET'));
  expect(response.status).toBe(200);
  const result = await response.json() as { jobs: Array<Record<string, unknown>> };
  expect(result.jobs[0]).toMatchObject({
    name: 'Daily planning check-in', agentId: 'wedding', enabled: true,
    schedule: { kind: 'cron', expr: '0 11 * * *', tz: 'America/New_York' },
    nextRunAt: 1790175600000, lastRunStatus: 'ok',
  });
  expect(JSON.stringify(result)).not.toContain('private prompt');
});

it('shows local rows beside the agent scheduler and without it', async () => {
  local.jobs = [{ id: 'launchd-a', name: 'com.example.nightly', readOnly: true }];
  const beside = await (await GET(request('GET'))).json() as { jobs: Array<{ id: string }> };
  expect(beside.jobs.map(job => job.id)).toEqual(['82ac2f70-5549-4827-8974-adf5519decf5', 'launchd-a']);
  process.env.O8_OPENCLAW_BIN = join(root, 'missing');
  invalidateCliCache('openclaw-cron');
  const alone = await GET(request('GET'));
  expect(alone.status).toBe(200);
  expect(await alone.json()).toMatchObject({ ok: true, available: true, jobs: local.jobs });
});

it('changes the source job and reads the persisted state back', async () => {
  const id = '82ac2f70-5549-4827-8974-adf5519decf5';
  const response = await PATCH(request('PATCH', { id, enabled: false }));
  expect(response.status).toBe(200);
  expect((await response.json()).job.enabled).toBe(false);
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ enabled: boolean }>;
  expect(persisted[0].enabled).toBe(false);
  expect((await (await GET(request('GET'))).json()).jobs[0].enabled).toBe(false);
});

it('rejects unauthenticated and unknown job mutations', async () => {
  auth.denied = true;
  expect((await GET(request('GET'))).status).toBe(401);
  expect((await PATCH(request('PATCH', { id: '82ac2f70-5549-4827-8974-adf5519decf5', enabled: false }))).status).toBe(401);
  auth.denied = false;
  expect((await PATCH(request('PATCH', { id: '00000000-0000-0000-0000-000000000000', enabled: false }))).status).toBe(404);
});
