import { renameSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = join(process.cwd(), 'scripts/release-summary.mjs');
const generated = { summary: 'Find work and updates more easily.', entries: [
  { text: 'Chat sections make recent work easier to find.', sourceIndices: [0] },
  { text: 'Connected updates are available together.', sourceIndices: [1] },
] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-summary-test-')); roots.push(root);
  const input = join(root, 'ship.json'); const output = join(root, 'notes.md'); const cli = join(root, 'codex');
  const cache = join(root, 'cache'); const effects = join(root, 'calls.jsonl'); const control = join(root, 'control.json');
  writeFileSync(input, JSON.stringify({ version: '0.1.904', summary: 'Clearer navigation and updates.',
    sourceCommits: ['private-source-id'], sections: [{ title: 'Changes', items: [
      'Clearer chat sections', 'One place for connected updates',
      'Codex internal adapter', 'Grok xAI adapter', '/Users/private/credentials', '/etc/private-key', 'owner@example.test',
    ] }] }));
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify({ args, prompt, cwd: process.cwd(), schema: JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) }) + '\\n');
if (control.O8_SUMMARY_TEST_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
if (control.O8_SUMMARY_TEST_FAIL) { console.error('private provider error'); process.exit(1); }
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], control.O8_SUMMARY_TEST_OUTPUT);
`); chmodSync(cli, 0o755);
  return { root, input, output, cli, cache, effects, control };
}
function options(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  // Fixture controls are private files, not ambient variables inherited by the
  // production CLI launch. The payer allowlist intentionally excludes them.
  writeFileSync(`${f.control}.tmp`, JSON.stringify({ O8_SUMMARY_TEST_OUTPUT: JSON.stringify(generated), ...extra }));
  renameSync(`${f.control}.tmp`, f.control);
  return { cwd: f.root, env: { ...process.env } };
}
function args(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return [script, '--input', f.input, '--out', f.output, '--cache-dir', f.cache, '--codex', f.cli, ...extra];
}
function run(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}, flags: string[] = []) {
  return spawnSync(process.execPath, args(f, flags), { ...options(f, extra), encoding: 'utf8', timeout: 10_000 });
}
function calls(f: ReturnType<typeof fixture>) {
  return existsSync(f.effects) ? readFileSync(f.effects, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('release summaries through the CLI and persisted publisher receipt', () => {
  it('pins Terra once, passes only public data, and reuses the result in a later process', () => {
    const f = fixture(); const first = run(f); expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ status: 'generated', cached: false, model: 'gpt-5.6-terra' });
    const [call] = calls(f); expect(call.args).toContain('--ignore-user-config'); expect(call.args).toContain('--ephemeral');
    expect(call.args.slice(call.args.indexOf('--model'), call.args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-5.6-terra']);
    expect(call.args).toContain('model_reasoning_effort="low"'); expect(call.args).toContain('web_search="disabled"');
    for (const feature of ['shell_tool', 'view_image', 'apps', 'plugins', 'browser_use', 'computer_use', 'hooks', 'memories', 'skill_search', 'workspace_dependencies']) {
      expect(call.args.some((arg: string, index: number) => arg === '--disable' && call.args[index + 1] === feature)).toBe(true);
    }
    expect(call.args).toContain('project_doc_max_bytes=0'); expect(call.args).toContain('tools.view_image=false');
    expect(call.args).toContain('skills.include_instructions=false');
    expect(call.args.slice(call.args.indexOf('--sandbox'), call.args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(call.prompt).not.toMatch(/private-source-id|\/Users\/|\/etc\/|owner@example|Codex|Grok|xAI/);
    expect(call.prompt).toContain('Clearer chat sections'); expect(call.prompt).not.toContain('internal adapter');
    expect(call.schema.additionalProperties).toBe(false); expect(existsSync(call.cwd)).toBe(false);
    const receipt = JSON.parse(readFileSync(join(f.cache, '0.1.904.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'generated', ...generated });
    expect(readFileSync(f.output, 'utf8')).toContain('## What’s changed\n\nFind work and updates more easily.');
    const second = run(f); expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: 'generated', cached: true }); expect(calls(f)).toHaveLength(1);
  });
  it('previews without inference or claiming a paid attempt', () => {
    const f = fixture(); const result = run(f, {}, ['--dry-run']); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('preview'); expect(calls(f)).toHaveLength(0); expect(existsSync(f.cache)).toBe(false);
  });
  it.each(['failure', 'unsafe', 'provider-name', 'private-path', 'invented-source'])('caches a safe fallback after %s and never retries automatically', mode => {
    const f = fixture(); const extra: Record<string, string> = mode === 'failure' ? { O8_SUMMARY_TEST_FAIL: '1' }
      : { O8_SUMMARY_TEST_OUTPUT: JSON.stringify({ ...generated, entries: [mode === 'unsafe'
        ? { text: 'Visit https://private.example.test', sourceIndices: [0] }
        : mode === 'provider-name' ? { text: 'Improved Grok and xAI support', sourceIndices: [0] }
        : mode === 'private-path' ? { text: 'Read /etc/private-key', sourceIndices: [0] }
        : { text: 'Another change', sourceIndices: [100] }] }) };
    expect(run(f, extra).status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.cache, '0.1.904.json'), 'utf8')).status).toBe('fallback');
    expect(readFileSync(f.output, 'utf8')).not.toMatch(/private provider error|private\.example|Grok|xAI|\/etc\//);
    expect(run(f).status).toBe(0); expect(calls(f)).toHaveLength(1);
  });
  it('refuses changed source under a version that already has an attempt receipt', () => {
    const f = fixture(); expect(run(f).status).toBe(0);
    writeFileSync(f.input, JSON.stringify({ version: '0.1.904', summary: 'Other changes.', sections: [{ items: ['Changed release source'] }] }));
    expect(run(f).status).toBe(1); expect(calls(f)).toHaveLength(1);
  });
  it('deduplicates simultaneous publisher processes with the claim written before the CLI starts', async () => {
    const f = fixture();
    const launch = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, args(f), { ...options(f, { O8_SUMMARY_TEST_DELAY: '1' }), stdio: 'ignore' });
      child.on('error', reject); child.on('exit', resolve);
    });
    expect(await Promise.all([launch(), launch()])).toEqual([0, 0]); expect(calls(f)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.cache, '0.1.904.json'), 'utf8')).status).toBe('generated');
  });
  it('does not retry an interrupted claim or accept a path as a release version', () => {
    const f = fixture(); expect(run(f).status).toBe(0);
    const file = join(f.cache, '0.1.904.json'); const receipt = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...receipt, status: 'pending' }));
    expect(JSON.parse(run(f).stdout)).toMatchObject({ status: 'fallback', cached: true }); expect(calls(f)).toHaveLength(1);
    writeFileSync(f.input, JSON.stringify({ version: '../../outside', sections: [] }));
    expect(run(f).status).toBe(1); expect(calls(f)).toHaveLength(1);
  });
});
