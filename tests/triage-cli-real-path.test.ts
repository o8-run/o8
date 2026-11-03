import { execFile } from 'node:child_process';
import { stop } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'o8-triage-test-'));
const entry = join(root, 'o8.mjs');
let sequence = 0;

beforeAll(async () => {
  symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  // Own the production build service here and stop it while this worker is alive.
  const argv = process.argv;
  const completed = new Error('CLI worker build completed');
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
    if (code !== 0) throw new Error('CLI worker build failed');
    throw completed;
  });
  try {
    process.argv = [process.execPath, 'cli/esbuild.config.mjs', '--worker-output', entry];
    try {
      await import(new URL('../cli/esbuild.config.mjs', import.meta.url).href);
    } catch (error) {
      if (error !== completed) throw error;
    }
  } finally {
    process.argv = argv;
    exit.mockRestore();
    await stop();
  }
}, 65_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(result = '## Mechanic\nA retained diagnostic reports a failure.\n\n## Expected\nThe operation completes.\n\n## Acceptance\n- [ ] Reproduce and verify the remedy.') {
  const directory = join(root, String(sequence++));
  const dataDir = join(directory, 'data');
  const record = join(directory, 'invocation.json');
  const binary = join(directory, 'local-agent');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'logs', 'serve.log'), 'retained-startup-failure\nAuthorization: Bearer synthetic-log-value\n');
  writeFileSync(join(dataDir, 'logs', 'next-server.log'), 'desktop-api-failure');
  writeFileSync(join(dataDir, 'logs', 'ws-server.log'), 'desktop-realtime-failure');
  mkdirSync(join(dataDir, 'telemetry'));
  writeFileSync(join(dataDir, 'telemetry', 'crashes.jsonl'), '{"message":"retained-crash"}\n');
  writeFileSync(binary, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'let prompt = "";',
    'process.stdin.on("data", chunk => { prompt += chunk; });',
    'process.stdin.on("end", () => {',
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));`,
    'const output = process.argv.indexOf("--output-last-message");',
    `const result = ${JSON.stringify(result)};`,
    'if (output >= 0) fs.writeFileSync(process.argv[output + 1], result);',
    'else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));',
    '});',
  ].join('\n'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', TMPDIR: root, HOME: directory, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    O8_API_PORT: '1', O8_CODEX_BIN: binary, NODE_OPTIONS: '' };
  const run = async (args: string[] = []) => {
    try {
      const output = await exec(process.execPath, [entry, 'triage', ...args], { env, cwd: directory, timeout: 20_000 });
      return { ...output, code: 0 };
    } catch (error) {
      return error as unknown as { stdout: string; stderr: string; code: number };
    }
  };
  return { directory, dataDir, record, binary, run };
}

describe('o8 triage through the bundled CLI', () => {
  it('passes retained logs and real offline doctor findings to a local agent and prints a draft', async () => {
    const f = fixture();
    const output = await f.run(['--model', 'gpt-5.6-sol']);
    expect(output.code, JSON.stringify(output)).toBe(0);
    const payload = JSON.parse(output.stdout);
    expect(payload).toMatchObject({ schema: 'o8/cli/triage/v1', filed: false, doctorExitCode: 1 });
    expect(payload.draft).toContain('## Mechanic');
    const invocation = JSON.parse(readFileSync(f.record, 'utf8'));
    expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-sol']));
    expect(invocation.prompt).toContain('o8/cli/doctor/v1');
    expect(invocation.prompt).toContain('network_error');
    expect(invocation.prompt).toContain('retained-startup-failure');
    expect(invocation.prompt).toContain('desktop-api-failure');
    expect(invocation.prompt).toContain('desktop-realtime-failure');
    expect(invocation.prompt).toContain('retained-crash');
    expect(invocation.prompt).toContain('[redacted]');
    expect(invocation.prompt).not.toContain('synthetic-log-value');
    expect(invocation.prompt).toContain('Never file');
    expect(invocation.cwd).not.toBe(f.directory);
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--ignore-user-config', 'read-only', 'approval_policy="never"', 'apps', 'plugins',
    ]));
  });

  it('prints a human-readable draft and applies the existing redactor to agent output', async () => {
    const f = fixture('## Mechanic\nAuthorization: Bearer synthetic-agent-value\n');
    const output = await f.run(['--human']);
    expect(output.code, JSON.stringify(output)).toBe(0);
    expect(output.stdout).toContain('Draft issue');
    expect(output.stdout).toContain('[redacted]');
    expect(output.stdout + output.stderr).not.toContain('synthetic-agent-value');
  });

  it('continues with missing logs and identifies them in the diagnostic bundle', async () => {
    const f = fixture();
    rmSync(join(f.dataDir, 'logs'), { recursive: true });
    const output = await f.run();
    expect(output.code, JSON.stringify(output)).toBe(0);
    expect(JSON.parse(readFileSync(f.record, 'utf8')).prompt).toContain('missing');
  });

  it('omits oversized logs without handing a partial record to the agent', async () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, 'logs', 'serve.log'), `oversized-sentinel${'x'.repeat(2 * 1024 * 1024)}`);
    const output = await f.run();
    expect(output.code, JSON.stringify(output)).toBe(0);
    const invocation = JSON.parse(readFileSync(f.record, 'utf8'));
    expect(invocation.prompt).toContain('omitted');
    expect(invocation.prompt).not.toContain('oversized-sentinel');
  });

  it('does not collect files linked into the log locations', async () => {
    const f = fixture();
    const target = join(f.directory, 'unrelated.txt');
    writeFileSync(target, 'unrelated-file-sentinel');
    rmSync(join(f.dataDir, 'logs', 'serve.log'));
    symlinkSync(target, join(f.dataDir, 'logs', 'serve.log'));
    const output = await f.run();
    expect(output.code, JSON.stringify(output)).toBe(0);
    const invocation = JSON.parse(readFileSync(f.record, 'utf8'));
    expect(invocation.prompt).toContain('unavailable');
    expect(invocation.prompt).not.toContain('unrelated-file-sentinel');
  });

  it.each([['--file'], ['--model', 'invalid model']])('rejects unsupported or malformed arguments: %j', async (...args) => {
    const f = fixture();
    const output = await f.run(args);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain('invalid_args');
    expect(existsSync(f.record)).toBe(false);
  });

  it('returns a diagnostic failure without exposing raw provider errors', async () => {
    const f = fixture();
    writeFileSync(f.binary, `#!${process.execPath}\nconsole.error('synthetic-provider-error'); process.exit(7);\n`, { mode: 0o700 });
    const output = await f.run();
    expect(output.code).toBe(5);
    expect(output.stderr).toContain('triage_failed');
    expect(output.stderr + output.stdout).not.toContain('synthetic-provider-error');
  });

  it('rejects an empty diagnosis', async () => {
    const f = fixture('');
    const output = await f.run();
    expect(output.code).toBe(5);
    expect(output.stderr).toContain('triage_failed');
  });

  it('documents the draft-only behavior in command help', async () => {
    const f = fixture();
    const output = await f.run(['--help']);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain('draft');
    expect(output.stdout).toContain('never files');
    expect(existsSync(f.record)).toBe(false);
  });
});
