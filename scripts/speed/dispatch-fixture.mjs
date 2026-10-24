#!/usr/bin/env node
// The existing scheduler fixture and persisted-stage observer, without accounts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { distribution, evidencePath, root, writeJson } from './common.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = evidencePath(option('output') ?? 'work/launch-fixture');
const payload = option('payload');
const soak = process.argv.includes('--soak');
const warm = !process.argv.includes('--cold');
const samples = Number(option('samples') ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error('Samples must be an integer from 1 to 20.');
const npmCli = process.env.npm_execpath ?? (process.env.PATH ?? '').split(path.delimiter)
  .map(directory => path.join(directory, 'npm')).filter(file => fs.existsSync(file))
  .map(file => fs.realpathSync(file)).find(file => path.basename(file) === 'npm-cli.js');
if (!npmCli) throw new Error('Run through npm or put the npm CLI symlink on PATH.');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const receipt = { schema: 'o8/speed-dispatch-fixture/v1', platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]), payload: payload ? 'installed-dependency-copy' : 'small-fixture', soak, warm, requestedSamples: samples, samples: [], failures: [],
  limits: soak ? 'Real delegate route, owned fixture workers, reviewed local Git merges and concurrent worktree reaping; no network or accounts. Linux event-loop timing only.' : 'Real scheduler, provisioning, owned runtime and stdout; fixture installer and runtime use no network or accounts. Optional payload is copied privately. No macOS, provider latency or physical-block claim.' };
for (let sample = 1; sample <= samples; sample++) {
  const file = path.join(output, `sample-${sample}.json`);
  const log = path.join(output, `sample-${sample}.log`);
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(log, 'w', 0o600);
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', soak ? 'tests/ws-work-soak-real-path.test.ts' : 'tests/packet-launch-budget-real-path.test.ts'], {
    cwd: root, stdio: ['ignore', fd, fd], timeout: soak ? 180_000 : 600_000,
    env: { ...process.env, npm_execpath: npmCli, O8_SPEED_RECEIPT: file, O8_SPEED_WARM: warm ? '1' : '0',
      ...(payload ? { O8_SPEED_DEPENDENCY_PAYLOAD: path.resolve(payload) } : {}) },
  });
  fs.closeSync(fd);
  if (fs.existsSync(file)) {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!soak) row.stages.otherWorkspaceMs = row.stages.workspaceProvisioningMs - row.stages.dependencyProvisioningMs;
    receipt.samples.push({ sample, ...row });
  }
  if (result.status !== 0) receipt.failures.push({ sample, exitCode: result.status, error: result.error?.code ?? null });
  writeJson(path.join(output, 'receipt.json'), receipt);
}
receipt.summary = Object.fromEntries((soak ? ['maxLag', 'p99Lag', 'wedges'] : ['dispatchToOutputMs', 'sessionMs', 'spawnToOutputMs']).map(key => [key, distribution(receipt.samples.map(row => row[key]))]));
if (!soak) receipt.phases = Object.fromEntries(['admissionMs', 'workspaceProvisioningMs', 'otherWorkspaceMs', 'dependencyProvisioningMs', 'runtimeSpawnMs'].map(key => [key, distribution(receipt.samples.map(row => row.stages[key]))]));
writeJson(path.join(output, 'receipt.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length || receipt.samples.length !== samples) process.exitCode = 1;
