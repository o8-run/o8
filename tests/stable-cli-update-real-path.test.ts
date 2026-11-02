import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '', selected: '', root: '', mode: 'native', version: '2.0.1', target: '2.0.2', busy: false,
  externalBusy: false, fail: false, wrongVersion: false, changedOwner: false, source: 'which', calls: [] as Array<{ command: string; args: string[] }> }));
// Installation checks resolve executable paths; the mocked home must use the same canonical root.
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-stable-cli-route-')));
fixture.home = join(directory, 'home');
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(directory, 'data'));
vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture.home, '.claude'));
vi.stubEnv('CODEX_HOME', join(fixture.home, '.codex'));
mkdirSync(process.env.CORTEX_IDE_DATA_DIR!, { recursive: true });
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'ws-token'), 'fixture-operator');
writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'worker-token'), 'fixture-worker');
vi.mock('server-only', () => ({}));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => fixture.home }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ unavailable: [], active: {
  lanes: fixture.busy ? [{ runtime: fixture.mode.startsWith('codex-') ? 'codex' : fixture.mode.startsWith('grok-') ? 'grok' : 'claude-code' }] : [], ownedSessions: [], managedRuns: [], terminalSessions: [],
} }) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ invalidateCliCache: vi.fn(),
  compareCliVersions: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
  resolveCli: async (spec: { runtimeId: string }) => ({ path: spec.runtimeId === 'npm' ? join(fixture.root, 'bin/npm') : fixture.selected,
    source: fixture.source, version: fixture.version }),
}));
vi.mock('node:child_process', () => ({ execFile: (command: string, args: string[], _options: unknown,
  callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
  if (command === '/bin/ps') { callback(null, fixture.externalBusy ? `claude ${fixture.selected}` : '', ''); return; }
  fixture.calls.push({ command, args });
  if (fixture.fail) { callback(new Error('fixture install failure')); return; }
  if (!fixture.wrongVersion) fixture.version = fixture.target;
  if (fixture.mode.startsWith('opencode-')) {
    const packageName = fixture.mode === 'opencode-old-npm' ? '@opencode-ai/cli' : '@opencode/cli';
    const file = join(fixture.root, 'lib/node_modules', packageName, 'package.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')); metadata.version = fixture.version; writeFileSync(file, JSON.stringify(metadata));
  }
  if (fixture.mode === 'grok-native') { writeFileSync(join(fixture.root, 'downloads/grok-linux-x86_64'), 'updated owned Grok fixture'); }
  if (fixture.mode === 'native' || fixture.mode === 'codex-native') {
    const codex = fixture.mode === 'codex-native';
    const commandName = codex ? 'codex' : 'claude';
    const launcher = join(fixture.home, '.local/bin', commandName);
    const packageRoot = join(fixture.root, `${fixture.version}-x86_64-unknown-linux-gnu`);
    if (codex) {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: fixture.version, target: 'x86_64-unknown-linux-gnu', variant: 'codex', entrypoint: 'bin/codex' }));
    }
    const target = codex ? join(packageRoot, 'bin/codex') : join(fixture.root, fixture.version);
    writeFileSync(target, 'owned native fixture'); chmodSync(target, 0o700);
    rmSync(launcher); symlinkSync(target, launcher);
  }
  if (fixture.changedOwner) { rmSync(fixture.selected); writeFileSync(fixture.selected, 'unrecognized launcher'); }
  callback(null, '', '');
} }));
const route = await import('@/app/api/setup/cli-updates/route');
const request = (body: unknown = { runtime: 'claude-code' }, token = 'fixture-operator', stream = false) => route.POST(new Request('http://localhost/api/setup/cli-updates', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify(body),
}));
const receipt = (runtime = 'claude-code') => JSON.parse(readFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, `${runtime}-cli-update.json`), 'utf8'));
function setup(mode: string) {
  rmSync(fixture.home, { recursive: true, force: true });
  fixture.mode = mode; fixture.version = '2.0.1'; fixture.target = '2.0.2'; fixture.calls = []; fixture.busy = false;
  fixture.externalBusy = false; fixture.fail = false; fixture.wrongVersion = false; fixture.changedOwner = false; fixture.source = 'which';
  const command = mode.startsWith('codex-') ? 'codex' : mode.startsWith('grok-') ? 'grok' : mode.startsWith('opencode-') ? 'opencode2' : mode === 'gemini-npm' ? 'gemini' : 'claude';
  mkdirSync(join(fixture.home, '.o8/bin'), { recursive: true });
  fixture.selected = join(fixture.home, '.o8/bin', command);
  if (mode === 'grok-native') {
    fixture.root = join(fixture.home, '.grok');
    mkdirSync(join(fixture.root, 'bin'), { recursive: true }); mkdirSync(join(fixture.root, 'downloads'), { recursive: true });
    const target = join(fixture.root, 'downloads/grok-linux-x86_64'); writeFileSync(target, 'owned Grok fixture'); chmodSync(target, 0o700);
    symlinkSync(target, join(fixture.root, 'bin/grok')); symlinkSync(join(fixture.root, 'bin/grok'), fixture.selected);
  } else if (mode === 'native' || mode === 'codex-native') {
    const codex = mode === 'codex-native';
    fixture.root = codex ? join(fixture.home, '.codex/packages/standalone/releases') : join(fixture.home, '.local/share/claude/versions');
    mkdirSync(fixture.root, { recursive: true }); mkdirSync(join(fixture.home, '.local/bin'), { recursive: true });
    const packageRoot = join(fixture.root, `${fixture.version}-x86_64-unknown-linux-gnu`);
    if (codex) {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: fixture.version, target: 'x86_64-unknown-linux-gnu', variant: 'codex', entrypoint: 'bin/codex' }));
    }
    const target = codex ? join(packageRoot, 'bin/codex') : join(fixture.root, fixture.version);
    writeFileSync(target, 'owned native fixture'); chmodSync(target, 0o700);
    const launcher = join(fixture.home, '.local/bin', command); symlinkSync(target, launcher); symlinkSync(launcher, fixture.selected);
    mkdirSync(join(fixture.home, '.claude')); writeFileSync(join(fixture.home, '.claude/settings.json'), '{"autoUpdatesChannel":"stable"}');
  } else if (['npm', 'grok-npm', 'opencode-npm', 'opencode-old-npm', 'gemini-npm'].includes(mode)) {
    fixture.root = join(fixture.home, 'node');
    mkdirSync(join(fixture.root, 'bin'), { recursive: true });
    const packageName = mode === 'grok-npm' ? '@xai-official/grok' : mode === 'opencode-old-npm' ? '@opencode-ai/cli' : mode === 'opencode-npm' ? '@opencode/cli' : mode === 'gemini-npm' ? '@google/gemini-cli' : '@anthropic-ai/claude-code';
    for (const [name, binary] of [[packageName, command], ['npm', 'npm-cli.js']]) {
      const packageRoot = join(fixture.root, 'lib/node_modules', name); mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      const target = join(packageRoot, 'bin', binary); writeFileSync(target, 'owned npm fixture'); chmodSync(target, 0o700);
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: fixture.version, bin: { [command]: `bin/${command}` }, ...(mode.startsWith('opencode-') && name === packageName ? { scripts: { postinstall: 'node ./postinstall.mjs' } } : {}) }));
      if (mode.startsWith('opencode-') && name === packageName) writeFileSync(join(packageRoot, 'postinstall.mjs'), '// owned fixture hook');
      symlinkSync(target, join(fixture.root, 'bin', binary === command ? command : 'npm'));
    }
    symlinkSync(join(fixture.root, 'bin', command), fixture.selected);
  } else {
    fixture.root = join(fixture.home, 'brew');
    const packageName = mode === 'codex-brew' ? 'codex' : 'claude-code@latest';
    const target = join(fixture.root, 'Caskroom', packageName, '2.0.1', command);
    mkdirSync(join(fixture.root, 'Caskroom', packageName, '2.0.1'), { recursive: true });
    mkdirSync(join(fixture.root, 'bin'), { recursive: true });
    writeFileSync(target, 'owned brew fixture'); chmodSync(target, 0o700); symlinkSync(target, fixture.selected);
    writeFileSync(join(fixture.root, 'bin/brew'), 'owned brew fixture'); chmodSync(join(fixture.root, 'bin/brew'), 0o700);
  }
}
beforeEach(() => {
  for (const runtime of ['codex', 'claude-code', 'grok']) {
    rmSync(join(process.env.CORTEX_IDE_DATA_DIR!, `${runtime}-cli-update.lock`), { force: true });
    rmSync(join(process.env.CORTEX_IDE_DATA_DIR!, `${runtime}-cli-update.json`), { force: true });
  }
  setup('native');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('https://downloads.claude.ai/') || url === 'https://x.ai/cli/stable'
    ? new Response('2.0.2') : Response.json({ version: '2.0.2' })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

describe('connected stable CLI updates through the real operator route', () => {
  it('updates native Claude through the resolver alias, uses its stable feed, and persists verification', async () => {
    expect((await request()).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://downloads.claude.ai/claude-code-releases/stable', expect.anything());
    expect(fixture.calls).toEqual([{ command: fixture.selected, args: ['update'] }]);
    expect(receipt()).toMatchObject({ status: 'succeeded', manager: 'native', targetVersion: '2.0.2', selectedPath: fixture.selected });
    expect(readFileSync(join(fixture.home, '.claude/settings.json'), 'utf8')).toBe('{"autoUpdatesChannel":"stable"}');
    expect(existsSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-cli-update.lock'))).toBe(false);
  });
  it('uses the verified npm toolchain and selected prefix with a fixed package and version', async () => {
    setup('npm'); expect((await request()).status).toBe(200);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.command).toBe(process.execPath);
    expect(fixture.calls[0]?.args).toEqual(expect.arrayContaining(['--prefix', fixture.root, '--ignore-scripts', '@anthropic-ai/claude-code@2.0.2']));
    expect(receipt()).toMatchObject({ status: 'succeeded', manager: 'npm' });
  });
  it.each(['opencode-old-npm', 'opencode-npm'])('streams OpenCode progress for %s through the real route and persists the selected owner', async mode => {
    setup(mode);
    if (mode === 'opencode-old-npm') { fixture.version = '0.0.0-beta-100'; fixture.target = '0.0.0-beta-200'; }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: fixture.target })));
    const response = await request({ runtime: 'opencode' }, 'fixture-operator', true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await response.text();
    expect(stream).toContain('"stage":"checking"'); expect(stream).toContain('"stage":"installing"'); expect(stream).toContain('"stage":"verifying"'); expect(stream).toContain('event: result');
    const packageName = mode === 'opencode-old-npm' ? '@opencode-ai/cli' : '@opencode/cli';
    expect(fixture.calls[0]?.args).toEqual(expect.arrayContaining(['--prefix', fixture.root, `${packageName}@${fixture.target}`, '--ignore-scripts']));
    expect(fixture.calls[1]).toEqual({ command: process.execPath, args: [join(fixture.root, 'lib/node_modules', packageName, 'postinstall.mjs')] });
    expect(receipt('opencode')).toMatchObject({ runtime: 'opencode', status: 'succeeded', selectedPath: fixture.selected, targetVersion: fixture.target });
    expect(fetch).toHaveBeenCalledWith(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${mode === 'opencode-old-npm' ? 'next' : 'latest'}`, expect.anything());
    expect(existsSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'opencode-cli-update.lock'))).toBe(false);
  });
  it('streams a refusal without installing or claiming a verified result', async () => {
    fixture.busy = true;
    const response = await request({ runtime: 'claude-code' }, 'fixture-operator', true);
    const stream = await response.text(); expect(stream).toContain('event: error'); expect(stream).not.toContain('event: result'); expect(fixture.calls).toHaveLength(0);
  });
  it('finishes the owned installation receipt when the progress viewer disconnects', async () => {
    rmSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-cli-update.json'), { force: true });
    const response = await request({ runtime: 'claude-code' }, 'fixture-operator', true);
    const reader = response.body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('"stage":"checking"');
    await reader.cancel();
    await vi.waitFor(() => expect(receipt().status).toBe('succeeded'));
    expect(fixture.calls).toEqual([{ command: fixture.selected, args: ['update'] }]);
    expect(existsSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-cli-update.lock'))).toBe(false);
  });
  it('uses the verified standalone Codex updater and accepts the new owned release target', async () => {
    setup('codex-native'); expect((await request({ runtime: 'codex' })).status).toBe(200);
    expect(fixture.calls).toEqual([{ command: fixture.selected, args: ['update'] }]);
    expect(receipt('codex')).toMatchObject({ status: 'succeeded', manager: 'native', targetVersion: '2.0.2' });
  });
  it('updates installed native Grok with its own command and stable release check', async () => {
    setup('grok-native'); expect((await request({ runtime: 'grok' })).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://x.ai/cli/stable', expect.anything());
    expect(fixture.calls).toEqual([{ command: fixture.selected, args: ['--no-auto-update', 'update'] }]);
    expect(receipt('grok')).toMatchObject({ status: 'succeeded', manager: 'native' });
  });
  it('keeps npm Grok on its original updater before any package mutation', async () => {
    setup('grok-npm'); const response = await request({ runtime: 'grok' });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'manual-update' });
    expect(fixture.calls).toHaveLength(0);
    expect(existsSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'grok-cli-update.json'))).toBe(false);
  });
  it.each(['channel = "alpha"', 'installer = "gh-release"'])('keeps nonstandard native Grok policy unchanged: %s', async preference => {
    setup('grok-native'); writeFileSync(join(fixture.root, 'config.toml'), `[cli]\n${preference}\n`);
    expect((await request({ runtime: 'grok' })).status).toBe(409); expect(fixture.calls).toHaveLength(0);
    expect(readFileSync(join(fixture.root, 'config.toml'), 'utf8')).toBe(`[cli]\n${preference}\n`);
  });
  it('defers a running Grok lane without stopping any session', async () => {
    setup('grok-native'); fixture.busy = true;
    expect((await request({ runtime: 'grok' })).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it('leaves conditional Grok installer policy to its original updater', async () => {
    setup('grok-native'); writeFileSync(join(fixture.root, 'config.toml'), '[cli]\nchannel = "stable"\n[[version_overrides]]\nchannel = "alpha"\n');
    expect((await request({ runtime: 'grok' })).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it.each(['claude-brew', 'codex-brew'])('keeps the selected Homebrew package for %s', async mode => {
    setup(mode); const runtime = mode === 'codex-brew' ? 'codex' : 'claude-code';
    expect((await request({ runtime })).status).toBe(200);
    expect(fixture.calls).toEqual([{ command: join(fixture.root, 'bin/brew'), args: ['upgrade', '--cask', mode === 'codex-brew' ? 'codex' : 'claude-code@latest'] }]);
    expect(receipt(runtime)).toMatchObject({ status: 'succeeded', manager: 'homebrew' });
  });
  it('refuses worker authority, package arguments, unsupported runtimes, and custom selected paths without an install', async () => {
    expect((await request({ runtime: 'claude-code' }, 'fixture-worker')).status).toBe(403);
    expect((await request({ runtime: 'claude-code', command: 'anything' })).status).toBe(400);
    expect((await request({ runtime: 'not-a-runtime' })).status).toBe(400);
    fixture.source = 'env'; expect((await request()).status).toBe(409);
    expect(fixture.calls).toHaveLength(0);
  });
  it.each(['busy', 'externalBusy'] as const)('waits for %s sessions without stopping them', async key => {
    fixture[key] = true; expect((await request()).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it('refuses an existing persisted update lock', async () => {
    writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-cli-update.lock'), 'owned lock');
    expect((await request()).status).toBe(409); expect(fixture.calls).toHaveLength(0);
  });
  it.each(['fail', 'wrongVersion', 'changedOwner'] as const)('persists a failed receipt for %s and releases only its own lock', async key => {
    fixture[key] = true; expect((await request()).status).toBe(503);
    expect(receipt()).toMatchObject({ status: 'failed', targetVersion: '2.0.2' });
    expect(existsSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-cli-update.lock'))).toBe(false);
  });
});
