import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-help-audit-'));
const executable = join(directory, 'o8.mjs');

beforeAll(async () => {
  await build({ entryPoints: ['cli/src/index.ts'], outfile: executable, bundle: true,
    platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'import { createRequire as __helpRequire } from "node:module"; const require = __helpRequire(import.meta.url); globalThis.require = require;' },
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('operator help through the executable entry point', () => {
  it.each([
    ['mission create', ['--title', '--repo', 'dispatch', 'false']],
    ['mission dispatch', ['--mission', '--wait', '--watch', '--timeout']],
    ['mission status', ['--mission', '--cost']],
    ['packet merge-preview', ['--packet', 'read-only']],
    ['packet steer', ['--message', '--packet']],
    ['packet review', ['--approve', '--expected-sha', '--coverage', 'merges']],
    ['lease acquire', ['<resource>', '--ttl', '2h', '--wait']],
    ['lease status', ['<resource>']],
    ['task create', ['--title', '--repo', '--project']],
    ['task block', ['<id>', '--reason', '--code']],
  ])('%s exposes the arguments needed before making a call', (command, tokens) => {
    const output = execFileSync(process.execPath, [executable, ...command.split(' '), '--help'], {
      encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: directory, O8_API_PORT: '1' },
    });
    expect(output).toContain(`usage: o8 ${command}`);
    expect(output).toContain('Required:');
    expect(output).toContain('Defaults:');
    expect(output).toContain('Example: o8');
    for (const token of tokens) expect(output).toContain(token);
  });

  it('documents the separate lease stores and the bare duration unit', () => {
    const reference = readFileSync('AGENT_REFERENCE.md', 'utf8');
    expect(reference).toContain('Bare --ttl values are milliseconds');
    expect(reference).toContain('o8 lease acquire audit --ttl 2m');
    expect(reference).toContain('o8 team lease uses a separate checkout-local store');
    expect(reference).not.toContain('[--ttl <minutes>]');
    expect(reference).toContain('o8 mission create --title "Inspect behavior" --repo /path/to/repo');
  });

  it('gives external agents authenticated setup and executable spec syntax', () => {
    const external = readFileSync('docs/agents/EXTERNAL_AGENTS.md', 'utf8');
    expect(external).toContain('Loopback API calls require a bearer token');
    expect(external).not.toContain('localhost requests skip auth');
    expect(external).toContain('o8 spec check --repo /path/to/repo');
    expect(external).toContain('issues: ["495"]');
    expect(external).toContain('status: "deferred"');
    expect(external).toContain('holdMerges:true');
  });
});
