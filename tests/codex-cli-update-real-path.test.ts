import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateCliCache } from '@/lib/runtimes/shared/cli-resolver';

const fixture = vi.hoisted(() => ({ prefix: '', toolchain: '', selected: '', version: '0.144.1', source: 'which', busy: false, fail: false, wrongVersion: false, externalBusy: false, unrelatedBusy: false, changedPath: false, changedRealpath: false, missingProbes: 0, postProbes: 0, changeOnRecovery: '' as '' | 'path' | 'realpath', commands: [] as string[], calls: [] as string[][] }));
const root = mkdtempSync(join(tmpdir(), 'o8-codex-update-'));
process.env.CORTEX_IDE_DATA_DIR = join(root, 'data');
mkdirSync(process.env.CORTEX_IDE_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'ws-token'), 'operator-test-token');
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'worker-token'), 'worker-test-token');
vi.mock('server-only', () => ({}));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ unavailable: [], active: { lanes: fixture.busy ? [{ runtime: 'codex' }] : fixture.unrelatedBusy ? [{ runtime: 'claude-code' }] : [], ownedSessions: [], managedRuns: [], terminalSessions: fixture.unrelatedBusy ? [{ commandHint: 'zsh' }] : [] } }) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  invalidateCliCache: vi.fn(),
  compareCliVersions: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
  resolveCli: async (spec: { runtimeId: string }) => {
    if (spec.runtimeId !== 'codex') {
      return { path: join(fixture.toolchain, 'bin', spec.runtimeId), version: spec.runtimeId === 'node' ? '22.23.1' : '11.8.0', source: spec.runtimeId === 'node' && process.env.O8_NODE_BIN ? 'env' : 'which' };
    }
    if (fixture.calls.length > 0) {
      fixture.postProbes += 1;
      if (fixture.postProbes === 2 && fixture.changeOnRecovery) {
        const other = join(fixture.prefix, 'bin/other-codex');
        writeFileSync(other, 'fixture');
        if (fixture.changeOnRecovery === 'path') fixture.selected = other;
        else { rmSync(fixture.selected); symlinkSync(other, fixture.selected); }
      }
    }
    return { path: fixture.selected, version: fixture.calls.length > 0 && fixture.postProbes <= fixture.missingProbes ? undefined : fixture.version, source: fixture.source };
  },
}));
vi.mock('node:child_process', () => ({ execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
  if (command === '/bin/ps') { callback(null, fixture.externalBusy ? 'codex codex exec' : '', ''); return; }
  fixture.commands.push(command);
  fixture.calls.push(args);
  if (fixture.fail) callback(new Error('install failed'));
  else { if (fixture.changedRealpath) { const other = join(fixture.prefix, 'bin/other-codex'); writeFileSync(other, 'fixture'); rmSync(fixture.selected); symlinkSync(other, fixture.selected); } if (fixture.changedPath) fixture.selected = join(fixture.prefix, 'bin/other-codex'); if (!fixture.wrongVersion) fixture.version = '0.159.3'; callback(null, '', ''); }
} }));
const route = await import('@/app/api/setup/cli-updates/route');
const post = (body: unknown = {}, token = 'operator-test-token') => {
  const request = new Request('http://localhost/api/setup/cli-updates', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (route as unknown as { POST: (request: Request) => Promise<Response> }).POST(request);
};
const originalNodeOverride = process.env.O8_NODE_BIN;
beforeEach(() => {
  if (originalNodeOverride === undefined) delete process.env.O8_NODE_BIN;
  else process.env.O8_NODE_BIN = originalNodeOverride;
  fixture.prefix = join(root, 'prefix');
  fixture.toolchain = fixture.prefix;
  mkdirSync(join(fixture.prefix, 'bin'), { recursive: true });
  for (const [name, binary] of [['@openai/codex', 'codex'], ['npm', 'npm']] as const) {
    const packageRoot = join(fixture.prefix, 'lib/node_modules', name);
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    const file = join(packageRoot, 'bin', binary === 'npm' ? 'npm-cli.js' : 'codex.js');
    writeFileSync(file, 'fixture');
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.144.1' }));
    rmSync(join(fixture.prefix, 'bin', binary), { force: true });
    symlinkSync(file, join(fixture.prefix, 'bin', binary));
  }
  writeFileSync(join(fixture.prefix, 'bin/node'), 'fixture');
  chmodSync(join(fixture.prefix, 'bin/node'), 0o700);
  fixture.selected = join(fixture.prefix, 'bin/codex');
  fixture.version = '0.144.1'; fixture.source = 'which'; fixture.busy = false; fixture.fail = false; fixture.wrongVersion = false; fixture.unrelatedBusy = false; fixture.externalBusy = false; fixture.changedPath = false; fixture.changedRealpath = false; fixture.missingProbes = 0; fixture.postProbes = 0; fixture.changeOnRecovery = ''; vi.mocked(invalidateCliCache).mockClear(); fixture.commands = []; fixture.calls = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.159.3' }), { status: 200 })));
});
afterAll(() => {
  if (originalNodeOverride === undefined) delete process.env.O8_NODE_BIN;
  else process.env.O8_NODE_BIN = originalNodeOverride;
  vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
describe('Codex update through the operator route', () => {
  it('refuses worker and absent authority before any installation', async () => {
    expect((await post({}, 'worker-test-token')).status).toBe(403);
    expect((await post({}, '')).status).toBe(403);
    expect(fixture.calls).toHaveLength(0);
  });
  it('updates only the selected npm prefix and persists verified success', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toContain('@openai/codex@0.159.3');
    expect(fixture.calls[0]).toContain(realpathSync(fixture.prefix));
    expect(fixture.calls[0]).toContain('--registry=https://registry.npmjs.org');
    expect(fixture.calls[0]).toContain('--@openai:registry=https://registry.npmjs.org');
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'succeeded', selectedPath: fixture.selected, targetVersion: '0.159.3' });
  });
  it('recovers one missing version with a fresh probe and persists verified success', async () => {
    fixture.missingProbes = 1;
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'succeeded', installedVersion: '0.159.3' });
    expect(fixture.postProbes).toBe(2);
    expect(fixture.calls).toHaveLength(1);
    expect(vi.mocked(invalidateCliCache).mock.calls.filter(([runtime]) => runtime === 'codex')).toHaveLength(4);
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'succeeded', selectedPath: fixture.selected, targetVersion: '0.159.3' });
  });
  it('bounds missing-version recovery and persists verification failure', async () => {
    fixture.missingProbes = 3;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'verification-failed' });
    expect(fixture.postProbes).toBe(2);
    expect(fixture.calls).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'failed', targetVersion: '0.159.3' });
  });
  it.each(['changedPath', 'changedRealpath', 'wrongVersion'] as const)('refuses %s during missing-version recovery', async (change) => {
    fixture.missingProbes = 1;
    fixture[change] = true;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'verification-failed' });
    expect(fixture.postProbes).toBe(change === 'wrongVersion' ? 2 : 1);
    expect(fixture.calls).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt.status).toBe('failed');
  });
  it.each(['path', 'realpath'] as const)('refuses a changed %s on the recovery probe', async (change) => {
    fixture.missingProbes = 1;
    fixture.changeOnRecovery = change;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'verification-failed' });
    expect(fixture.postProbes).toBe(2);
    expect(fixture.calls).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt.status).toBe('failed');
  });
  it('uses the running Node with packaged O8_NODE_BIN and separate npm/Codex prefixes', async () => {
    process.env.O8_NODE_BIN = process.execPath;
    fixture.toolchain = join(root, 'toolchain');
    rmSync(join(fixture.prefix, 'lib/node_modules/npm'), { recursive: true });
    rmSync(join(fixture.prefix, 'bin/npm'));
    rmSync(join(fixture.prefix, 'bin/node'));
    mkdirSync(join(fixture.toolchain, 'lib/node_modules/npm/bin'), { recursive: true });
    mkdirSync(join(fixture.toolchain, 'bin'), { recursive: true });
    writeFileSync(join(fixture.toolchain, 'lib/node_modules/npm/package.json'), JSON.stringify({ name: 'npm' }));
    writeFileSync(join(fixture.toolchain, 'lib/node_modules/npm/bin/npm-cli.js'), 'fixture');
    writeFileSync(join(fixture.toolchain, 'bin/node'), 'fixture'); chmodSync(join(fixture.toolchain, 'bin/node'), 0o700);
    symlinkSync(join(fixture.toolchain, 'lib/node_modules/npm/bin/npm-cli.js'), join(fixture.toolchain, 'bin/npm'));
    const response = await post(); expect(response.status).toBe(200);
    expect(fixture.commands[0]).toBe(realpathSync(process.execPath));
    const receipt = JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'succeeded', selectedPath: fixture.selected, targetVersion: '0.159.3' });
    expect(fixture.calls[0][0]).toBe(realpathSync(join(fixture.toolchain, 'bin/npm')));
    expect(fixture.calls[0]).toContain(realpathSync(fixture.prefix));
    expect(fixture.calls[0]).not.toContain(realpathSync(fixture.toolchain));
  });
  it('rejects client command, package, version, and path injection', async () => {
    expect((await post({ package: 'evil', command: 'touch stolen', version: '0.159.3;bad', path: '/wrong' })).status).toBe(400);
    expect(fixture.calls).toHaveLength(0);
  });
  it('refuses overridden, custom, and unsupported manager installations', async () => {
    fixture.source = 'env'; expect((await post()).status).toBe(409);
    fixture.source = 'which'; fixture.selected = join(root, 'custom-codex'); writeFileSync(fixture.selected, 'fixture');
    expect((await post()).status).toBe(409);
    expect(fixture.calls).toHaveLength(0);
  });
  it('waits for active sessions instead of stopping them', async () => {
    fixture.busy = true; expect((await post()).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it('preserves unrelated runtimes and idle shell terminals without blocking', async () => {
    fixture.unrelatedBusy = true; expect((await post()).status).toBe(200); expect(fixture.calls).toHaveLength(1);
  });
  it('refuses active Codex processes outside the managed inventory', async () => {
    fixture.externalBusy = true; expect((await post()).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it('refuses a different selected path after installation', async () => {
    fixture.changedPath = true; expect((await post()).status).toBe(503);
  });
  it('does not install a current or unverified version', async () => {
    fixture.version = '0.159.3'; expect((await post()).status).toBe(409);
    fixture.version = ''; expect((await post()).status).toBe(409);
    expect(fixture.calls).toHaveLength(0);
  });
  it('refuses an existing operation lock without installing', async () => {
    const lock = join(process.env.CORTEX_IDE_DATA_DIR!, 'codex-cli-update.lock');
    writeFileSync(lock, 'existing operation');
    expect((await post()).status).toBe(409); expect(readFileSync(lock, 'utf8')).toBe('existing operation');
    rmSync(lock); expect(fixture.calls).toHaveLength(0);
  });
  it('reports install failure without success', async () => {
    fixture.fail = true; expect((await post()).status).toBe(503);
  });
  it('requires verification of the selected version', async () => {
    fixture.wrongVersion = true; expect((await post()).status).toBe(503); expect(fixture.postProbes).toBe(1);
  });
  it('rejects unstable release metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.159.3-beta.1' }))));
    expect((await post()).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
});
