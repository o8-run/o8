import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRepositoryRuleCheck } from './repository-rule-check';

const directories: string[] = [];
function fixture(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'o8-rule-spawn-'));
  directories.push(cwd);
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline']);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), `${content}\n`);
  }
  return cwd;
}

afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('child-process rule through the real git-backed entry point', () => {
  it.each([
    ["require alias", "const load = require; const cp = load('node:child_process'); cp.spawn('tool');"],
    ["require destructuring", "const { spawn: launch } = require('node:child_process'); launch('tool');"],
    ["createRequire alias", "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); const { spawn: launch } = load('node:child_process'); launch('tool');"],
    ["createRequire namespace", "import * as mod from 'module'; const load = mod.createRequire(import.meta.url); load('child_process').execSync('tool');"],
    ["execa", "import { execa as launch } from 'execa'; launch('tool');"],
    ["worker threads", "const { Worker: Launch } = require('node:worker_threads'); new Launch('tool');"],
    ["shell string", "import { execSync } from 'node:child_process'; execSync('tool --header=secret');"],
  ])('rejects uncovered launch form %s', async (_form, source) => {
    const result = await runRepositoryRuleCheck(fixture({ 'src/lib/example/launch.ts': source }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'child-process-boundary')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it.each([
    "import { spawn } from 'node:child_process'; spawn('tool', [], { env: process.env });",
    "import { spawn as launch } from 'child_process'; launch('tool', [], { env: { ...process.env } });",
    "import * as cp from 'node:child_process'; cp.spawn('tool');",
    "import cp from 'child_process'; cp.execFile('tool', []);",
    "const { fork: launch } = require('node:child_process'); launch('tool');",
    "const cp = require('child_process'); cp.execSync('tool');",
    "const cp = await import('node:child_process'); cp.spawnSync('tool');",
    "import cp = require('child_process'); cp.exec('tool');",
    "export { spawn as launch } from 'node:child_process';",
    "export * from 'child_process';",
    "import 'node:child_process';",
    "import { type ChildProcess, spawn } from 'node:child_process';",
  ])('rejects a raw builtin boundary: %s', async source => {
    const result = await runRepositoryRuleCheck(fixture({ 'src/lib/example/launch.ts': source }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'child-process-boundary')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it.each([
    "import { spawn } from '@/lib/providers/child-process'; spawn('tool', [], { env: process.env });",
    "import { spawnWithWorkAdmission } from '@/lib/app-update/work-launch-admission'; spawnWithWorkAdmission('tool', [], { env: process.env });",
    "import { spawnWithWorkAdmission as launch } from '@/lib/app-update/work-launch-admission'; launch('tool', [], { env: { ...process.env } });",
    "import * as admitted from '../app-update/work-launch-admission'; admitted.spawnWithWorkAdmission('tool', [], { env: process.env });",
    "import { spawn as launch } from '../providers/child-process'; const inherited = process.env; launch('tool', [], { env: { ...inherited } });",
    "import * as cp from '@/lib/providers/child-process'; const options = { env: process.env }; cp.execFile('tool', [], options);",
    "import { execSync } from '@/lib/providers/child-process'; import processAlias from 'node:process'; execSync('tool', { env: processAlias.env });",
    "import { fork } from '@/lib/providers/child-process'; const { env } = process; fork('tool', [], { env });",
    "import * as pty from 'node-pty'; pty.spawn('tool', [], { env: { ...process.env } });",
    "const { spawn: launch } = require('node-pty'); launch('tool', [], { env: process['env'] });",
    "const pty = await import('node-pty'); const inherited = { ...process.env }; pty.spawn('tool', [], { env: inherited });",
    "import { spawn } from '@/lib/providers/child-process'; let inherited = {}; inherited = process.env; spawn('tool', [], { env: inherited });",
    "import { spawn } from '@/lib/providers/child-process'; spawn('tool', [], Object.assign({}, { env: process.env }));",
    "import('node-pty').then(pty => pty.spawn('tool', [], { env: process.env }));",
    "import('node-pty').then(({ spawn: launch }) => launch('tool', [], { env: process.env }));",
    "let pty; pty = require('node-pty'); pty.spawn('tool', [], { env: process.env });",
    "import { spawn } from '@/lib/providers/child-process'; const launch = spawn; launch('tool', [], { env: Object.assign({}, process.env) });",
  ])('rejects raw inherited launch environment: %s', async source => {
    const result = await runRepositoryRuleCheck(fixture({ 'src/lib/example/launch.ts': source }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'spawn-environment')).toBe(true);
  });

  it.each([
    "import { spawn } from 'node:child_process'; spawn('tool');",
    "import { execFile } from 'node:child_process'; execFile('tool', []);",
    "import { execSync } from 'node:child_process'; execSync('tool', { cwd: '.' });",
    "import * as cp from 'child_process'; cp.fork('tool', [], { env: undefined });",
    "import * as pty from 'node-pty'; pty.spawn('tool', []);",
  ])('rejects implicit env at a raw launch boundary: %s', async source => {
    const result = await runRepositoryRuleCheck(fixture({ 'src/lib/providers/child-process.ts': source }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'spawn-environment')).toBe(true);
  });

  it.each(['src/lib/mcp/test-connection.ts', 'src/lib/lane/solo-deferred-launch.ts'])('guards the former deferred boundary %s', async path => {
    const result = await runRepositoryRuleCheck(fixture({ [path]: "import { spawn } from 'node:child_process'; spawn('tool', [], { env: process.env });" }), 'HEAD');
    expect(result.violations.map(violation => violation.rule)).toEqual(expect.arrayContaining(['child-process-boundary', 'spawn-environment']));
  });

  it('accepts the builder, typed wrapper, type-only imports, and unrelated spawn methods', async () => {
    const result = await runRepositoryRuleCheck(fixture({
      'src/lib/providers/spawn-environment.ts': 'export const buildEnvironment = () => ({ ...process.env });',
      'src/lib/providers/child-process.ts': "import { spawn as rawSpawn } from 'node:child_process'; import { buildEnvironment } from './spawn-environment'; export const spawn = () => rawSpawn('tool', [], { env: buildEnvironment() });",
      'src/launch.ts': "import type { ChildProcess } from 'node:child_process'; import { type SpawnOptions } from 'child_process'; export type { ExecOptions } from 'node:child_process'; type Module = typeof import('node:child_process'); import { spawn } from '@/lib/providers/child-process'; spawn('tool'); const packet = { spawn: (_options: unknown) => {} }; packet.spawn({ env: process.env });",
      'src/callback.ts': "import { exec } from '@/lib/providers/child-process'; exec('tool', () => process.env);",
      'src/scalar.ts': "import { spawn } from '@/lib/providers/child-process'; spawn('tool', [], { env: { PATH: process.env.PATH } });",
      'src/shadow.ts': "import { spawn } from '@/lib/providers/child-process'; function unrelated(spawn: (x: unknown) => void) { spawn({ env: process.env }); }",
      'src/launch.test.ts': "import { spawn } from 'node:child_process'; spawn('tool');",
    }), 'HEAD');
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('resolves local wrapper imports in the providers directory', async () => {
    const result = await runRepositoryRuleCheck(fixture({
      'src/lib/providers/launch.ts': "import { spawn } from './child-process'; spawn('tool', [], { env: process.env });",
    }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'spawn-environment')).toBe(true);
  });

  it('terminates alias analysis on circular assignments', async () => {
    const result = await runRepositoryRuleCheck(fixture({
      'src/lib/example/launch.ts': "let load; load = load.bind('fixture'); load('node:child_process');",
    }), 'HEAD');
    expect(result.violations).toEqual([]);
  });

  it('checks the structural inline PTY module at its known raw boundary', async () => {
    const result = await runRepositoryRuleCheck(fixture({
      'src/lib/ws-server/terminal-host-client.ts': "interface InlinePtyModule { spawn(...args: unknown[]): void } export function make(ptyModule: InlinePtyModule) { ptyModule.spawn('tool', [], { env: process.env }); }",
    }), 'HEAD');
    expect(result.violations.some(v => v.rule === 'spawn-environment')).toBe(true);
  });

  it('scans unchanged unsafe lines in a changed source file', async () => {
    const cwd = fixture({ 'src/launch.ts': "import { spawn } from 'node:child_process';\nspawn('tool', [], { env: process.env });\nexport const unrelated = 1;" });
    execFileSync('git', ['-C', cwd, 'add', '.']);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'existing launch']);
    writeFileSync(join(cwd, 'src/launch.ts'), "import { spawn } from 'node:child_process';\nspawn('tool', [], { env: process.env });\nexport const unrelated = 2;\n");
    const result = await runRepositoryRuleCheck(cwd, 'HEAD');
    expect(result.violations.some(v => v.rule === 'child-process-boundary' && v.line === 1)).toBe(true);
    expect(result.violations.some(v => v.rule === 'spawn-environment' && v.line === 2)).toBe(true);
  });
});
