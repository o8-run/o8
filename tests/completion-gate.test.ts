import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = path.resolve('dist/hooks/completion-gate.js');
function fixture(changed = true, behavior = "console.log('file.ts(1,1): error TS2322: wrong type'); process.exit(1)") {
  const root = mkdtempSync(path.join(os.tmpdir(), 'completion-gate-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'typecheck:fast': 'node check.cjs' } }));
  writeFileSync(path.join(root, 'check.cjs'), `require('node:fs').appendFileSync('started', 'run\\n'); ${behavior}`);
  writeFileSync(path.join(root, 'file.ts'), 'const n: number = 1;');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  if (changed) writeFileSync(path.join(root, 'file.ts'), 'const n: number = "wrong";');
  const record = path.join(root, '.git/o8/completion-gate.jsonl');
  function run(extra = {}, script = entry, mode = 'observe') {
    return spawnSync(process.execPath, [script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ session_id: 'test', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, ...extra }),
      env: { ...process.env, O8_COMPLETION_GATE_MODE: mode },
    });
  }
  return { root, git, run, record, rows: () => readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

describe('completion gate real Stop entry point', () => {
  it('records type errors without blocking in default observe mode, one line per run', () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const result = f.run({}, entry, '');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(f.rows()).toHaveLength(2);
    expect(f.rows()[0]).toMatchObject({ outcome: 'type errors found', changedFiles: 1, wouldBlock: true, mode: 'observe' });
    expect(f.rows()[0].durationMs).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(f.rows()[0].time))).toBe(false);
    expect(readFileSync(f.record, 'utf8')).not.toContain(f.root);
  });
  it('records a passing check', () => {
    const f = fixture(true, 'process.exit(0)');
    expect(f.run().status).toBe(0);
    expect(f.rows()[0]).toMatchObject({ outcome: 'passed', wouldBlock: false });
  });
  it('skips a session without TypeScript changes', () => {
    const f = fixture(false);
    writeFileSync(path.join(f.root, 'readme.md'), 'changed');
    expect(f.run().status).toBe(0);
    expect(existsSync(path.join(f.root, 'started'))).toBe(false);
    expect(existsSync(f.record)).toBe(false);
  });
  it('ignores recursive Stop and old PostToolUse payloads', () => {
    const f = fixture();
    for (const payload of [{ stop_hook_active: true }, ...['Bash', 'TaskStop', 'Stop'].map(tool_name => ({ hook_event_name: 'PostToolUse', tool_name }))]) {
      expect(f.run(payload).status).toBe(0);
    }
    expect(existsSync(path.join(f.root, 'started'))).toBe(false);
    expect(existsSync(f.record)).toBe(false);
  });
  it('records timeout as could not finish through the same entry point with a shortened deadline', () => {
    const f = fixture(true, 'setTimeout(() => {}, 60000)');
    const short = path.join(f.root, 'short-gate.cjs');
    writeFileSync(short, readFileSync(entry, 'utf8').replace(/const TIMEOUT_MS = [\d_]+;/, 'const TIMEOUT_MS = 1000;'));
    expect(f.run({}, short).status).toBe(0);
    expect(f.rows()[0]).toMatchObject({ outcome: 'could not finish', reason: 'timeout', wouldBlock: false });
  });
  it('distinguishes tool failure from type diagnostics', () => {
    const f = fixture(true, "console.error('checker unavailable'); process.exit(1)");
    expect(f.run().status).toBe(0);
    expect(f.rows()[0]).toMatchObject({ outcome: 'could not finish', reason: 'tool failure' });
  });
  it('counts staged, unstaged, untracked and renamed TypeScript paths against HEAD', () => {
    const f = fixture(false, 'process.exit(0)');
    f.git('mv', 'file.ts', 'renamed.tsx');
    writeFileSync(path.join(f.root, 'new.ts'), 'export {};');
    mkdirSync(path.join(f.root, 'subdir'));
    expect(f.run({ cwd: path.join(f.root, 'subdir') }).status).toBe(0);
    expect(f.rows()[0].changedFiles).toBe(3); // deleted old path, renamed destination, new path
  });
  it('can explicitly block type errors only after owner opt-in', () => {
    const f = fixture();
    expect(f.run({}, entry, 'block').status).toBe(2);
    expect(f.run({ stop_hook_active: true }, entry, 'block').status).toBe(0);
  });
  it('registers only on Stop and keeps the built artifact equal to source', () => {
    const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('completion-gate.js');
    expect(JSON.stringify(settings.hooks.PostToolUse ?? [])).not.toContain('completion-gate');
    expect(readFileSync(entry, 'utf8')).toBe(readFileSync('scripts/hooks/completion-gate.cjs', 'utf8'));
  });
});
