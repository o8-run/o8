import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
// Keep other installed runtimes outside this fixture's settings-route inventory.
vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  return { ...actual, getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: { pi: await actual.detectRuntimeAuthStatus('pi') },
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })) };
});

const root = realpathSync(mkdtempSync(path.join(getDataDir(), 'o8-pi-user-')));
const agentDir = path.join(root, 'agent');
const cwd = path.join(root, 'project');
const sessions = path.join(root, 'history');
const sessionFile = path.join(sessions, 'saved.jsonl');
const binary = path.join(root, 'pi.mjs');
const versionFile = path.join(root, 'pi-version.txt');
const receipt = path.join(root, 'receipt.jsonl');
const marker = 'fixture-auth-value-must-stay-private';
const env = {
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: '',
  O8_PI_BIN: binary,
  O8_OWNED_PI_ROOT: path.join(root, 'owned'),
  O8_OWNED_PI_ARCHIVE_ROOT: path.join(root, 'archive'),
};
const priorEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
for (const dir of [agentDir, cwd, sessions, path.join(agentDir, 'extensions'), path.join(agentDir, 'skills', 'fixture'), path.join(cwd, '.pi')]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture-provider', defaultModel: 'fixture-model', sessionDir: sessions }));
writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ token: marker }));
writeFileSync(path.join(agentDir, 'extensions', 'fixture.ts'), 'export default () => {};');
writeFileSync(path.join(agentDir, 'skills', 'fixture', 'SKILL.md'), 'Fixture skill');
writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'project-provider' }));
const savedBytes = JSON.stringify({ type: 'session', version: 3, id: 'fixture-session', timestamp: '2026-01-01T00:00:00.000Z', cwd }) + '\n';
writeFileSync(sessionFile, savedBytes);
const savedMtime = statSync(sessionFile).mtimeMs;
// Child environments omit fixture-only variables; keep controls in the fixture.
writeFileSync(versionFile, '1.0.2');
writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('pi ' + readFileSync(${JSON.stringify(versionFile)}, 'utf8')); process.exit(0); }
const session = argv[argv.indexOf('--session') + 1];
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ argv, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR, pid: process.pid }) + '\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'prompt' || command.type === 'follow_up') {
    if (argv.includes('--session')) {
      if (!readFileSync(session, 'utf8').includes('fixture-session')) process.exit(2);
      appendFileSync(session, JSON.stringify({ type: 'fixture-resumed' }) + '\\n');
    }
    console.log(JSON.stringify({ type: 'agent_end' }));
    setTimeout(() => process.exit(0), 50);
  }
  if (command.type === 'get_state') console.log(JSON.stringify({ type: 'response', command: 'get_state', data: { sessionId: 'fixture-session', sessionFile: argv.includes('--session') ? session : undefined } }));
});
`);
chmodSync(binary, 0o755);

const { piRuntime } = await import('@/lib/runtimes/pi');
const { discoverRuntimeSessions } = await import('@/lib/runtime/inventory-discovery');
const { detectRuntimeAuthStatus, getDispatchableRuntimeAvailability } = await import('@/lib/runtimes/shared/auth-detect');
const { getOperatorDefaults } = await import('@/lib/operator/defaults');
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
invalidateCliCache('pi');

interface Receipt { argv: string[]; cwd: string; agentDir: string; sessionDir: string; pid: number }
const ownedKeys: string[] = [];
function receipts(): Receipt[] {
  return existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}
async function waitForReceipt(count: number): Promise<Receipt> {
  await vi.waitFor(() => expect(receipts()).toHaveLength(count), { timeout: 10_000 });
  const result = receipts()[count - 1];
  await vi.waitFor(() => {
    expect(() => process.kill(result.pid, 0)).toThrow();
  }, { timeout: 10_000 });
  return result;
}
async function discovered() {
  const result = (await discoverRuntimeSessions([piRuntime], { fresh: true }))[0];
  expect(result.status).toBe('fulfilled');
  return result.status === 'fulfilled' ? result.value.sessions : [];
}

afterAll(async () => {
  for (const key of ownedKeys) await piRuntime.interrupt(key).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateCliCache('pi');
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('existing Pi setup through worker entry points', () => {
  it('reports only safe setup fields through the runtime settings data path without reading auth', async () => {
    const before = await getOperatorDefaults();
    const open = vi.mocked(fs.open);
    const read = vi.mocked(fs.readFile);
    const status = await detectRuntimeAuthStatus('pi');
    const inventory = await getDispatchableRuntimeAvailability({
      statuses: { pi: status }, suggestedSubscriptionProfile: { profile: null, detail: null },
    } as Parameters<typeof getDispatchableRuntimeAvailability>[0]);
    expect(inventory.find((item) => item.id === 'pi')).toMatchObject({
      available: true,
      piSetup: { agentDir, detected: true, binaryPath: binary, version: '1.0.2', provider: 'fixture-provider', model: 'fixture-model', credentialsPresent: true, extensions: 1, skills: 1, sessions: 1 },
    });
    expect(JSON.stringify({ status, inventory })).not.toContain(marker);
    const auth = path.join(agentDir, 'auth.json');
    expect(open.mock.calls.some(([file]) => String(file) === auth)).toBe(false);
    expect(read.mock.calls.some(([file]) => String(file) === auth)).toBe(false);
    const route = await import('@/app/api/panel/operator-defaults/route');
    const response = await route.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.dispatchableRuntimes.find((item: { id: string }) => item.id === 'pi')).toMatchObject({
      available: true, piSetup: { provider: 'fixture-provider', model: 'fixture-model' },
    });
    expect(JSON.stringify(payload)).not.toContain(marker);
    expect(await getOperatorDefaults()).toEqual(before);
  });

  it('reports the warming default, configured modes and old Pi versions through inventory', async () => {
    const file = path.join(agentDir, 'settings.json');
    const saved = readFileSync(file);
    const priorVersion = readFileSync(versionFile);
    try {
      for (const mode of [undefined, 'off', 'streaming', 'idle']) {
        writeFileSync(file, JSON.stringify({ cacheWarming: mode }));
        const status = await detectRuntimeAuthStatus('pi');
        expect(status).toMatchObject({ piSetup: { cacheWarming: mode ?? 'streaming', cacheWarmingSupported: true } });
      }
      writeFileSync(versionFile, '0.85.9');
      invalidateCliCache('pi');
      expect(await detectRuntimeAuthStatus('pi')).toMatchObject({ piSetup: { version: '0.85.9', cacheWarmingSupported: false } });
    } finally {
      writeFileSync(file, saved);
      writeFileSync(versionFile, priorVersion);
      invalidateCliCache('pi');
    }
  });

  it('writes only the global warming setting through the actual route and rereads it', async () => {
    const { POST } = await import('@/app/api/setup/pi/cache-warming/route');
    const file = path.join(agentDir, 'settings.json');
    const saved = readFileSync(file);
    const raw = '{\r\n\t"nested": { "cacheWarming": "off" },\r\n\t"cacheWarming" : "streaming",\r\n\t"other": [1, 2]\r\n}\r\n';
    try {
      writeFileSync(file, raw);
      const response = await POST(new Request('http://localhost/api/setup/pi/cache-warming', {
        method: 'POST', body: JSON.stringify({ cacheWarming: 'idle' }),
      }));
      expect(response.status).toBe(200);
      expect(readFileSync(file, 'utf8')).toBe(raw.replace('"cacheWarming" : "streaming"', '"cacheWarming" : "idle"'));
      expect(await detectRuntimeAuthStatus('pi')).toMatchObject({ piSetup: { cacheWarming: 'idle' } });
      writeFileSync(file, '{\n  "other": 42\n}\n');
      const added = await POST(new Request('http://localhost/api/setup/pi/cache-warming', {
        method: 'POST', body: JSON.stringify({ cacheWarming: 'off' }),
      }));
      expect(added.status).toBe(200);
      expect(readFileSync(file, 'utf8')).toBe('{\n  "other": 42,\n  "cacheWarming": "off"\n}\n');
      expect(readFileSync(path.join(cwd, '.pi', 'settings.json'), 'utf8')).toBe(JSON.stringify({ defaultProvider: 'project-provider' }));
      // Escaped top-level keys still refer to the same setting; nested objects
      // must not be mistaken for the global mode.
      writeFileSync(file, '{"cache\\u0057arming": {"old": true}, "keep": [1, 2]}');
      expect((await POST(new Request('http://localhost/api/setup/pi/cache-warming', {
        method: 'POST', body: JSON.stringify({ cacheWarming: 'streaming' }),
      }))).status).toBe(200);
      expect(readFileSync(file, 'utf8')).toBe('{"cache\\u0057arming": "streaming", "keep": [1, 2]}');
      rmSync(file);
      expect((await POST(new Request('http://localhost/api/setup/pi/cache-warming', {
        method: 'POST', body: JSON.stringify({ cacheWarming: 'off' }),
      }))).status).toBe(200);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ cacheWarming: 'off' });
    } finally { writeFileSync(file, saved); }
  });

  it('refuses symlinked, non-regular, malformed and oversized settings without changing them', async () => {
    const { POST } = await import('@/app/api/setup/pi/cache-warming/route');
    const file = path.join(agentDir, 'settings.json');
    const saved = readFileSync(file);
    const target = path.join(root, 'linked-settings.json');
    writeFileSync(target, '{"cacheWarming":"off"}');
    const post = () => POST(new Request('http://localhost/api/setup/pi/cache-warming', {
      method: 'POST', body: JSON.stringify({ cacheWarming: 'idle' }),
    }));
    try {
      rmSync(file);
      symlinkSync(target, file);
      expect((await post()).status).toBe(409);
      expect(readFileSync(target, 'utf8')).toBe('{"cacheWarming":"off"}');
      rmSync(file);
      mkdirSync(file);
      expect((await post()).status).toBe(409);
      rmSync(file, { recursive: true });
      for (const raw of ['{broken', '[]', '{"cacheWarming":"off","cacheWarming":"idle"}', 'x'.repeat(65_537)]) {
        writeFileSync(file, raw);
        expect((await post()).status).toBe(409);
        expect(readFileSync(file, 'utf8')).toBe(raw);
      }
    } finally { rmSync(file, { recursive: true, force: true }); writeFileSync(file, saved); }
  });

  it('preserves malformed UTF-8 and concurrent external edits by refusing the write', async () => {
    const { POST } = await import('@/app/api/setup/pi/cache-warming/route');
    const file = path.join(agentDir, 'settings.json');
    const saved = readFileSync(file);
    const post = () => POST(new Request('http://localhost/api/setup/pi/cache-warming', {
      method: 'POST', body: JSON.stringify({ cacheWarming: 'idle' }),
    }));
    const originalOpen = vi.mocked(fs.open).getMockImplementation()!;
    try {
      const invalid = Buffer.concat([Buffer.from('{"other":"'), Buffer.from([0xff]), Buffer.from('","cacheWarming":"off"}')]);
      writeFileSync(file, invalid);
      expect((await post()).status).toBe(409);
      expect(readFileSync(file)).toEqual(invalid);
      writeFileSync(file, '{"cacheWarming":"off"}');
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith('.tmp')) writeFileSync(file, '{"external":"new setting"}');
        return handle;
      });
      expect((await post()).status).toBe(409);
      expect(readFileSync(file, 'utf8')).toBe('{"external":"new setting"}');
    } finally { vi.mocked(fs.open).mockImplementation(originalOpen); writeFileSync(file, saved); }
  });

  it('rejects invalid choices and unsupported Pi versions without a settings write', async () => {
    const { POST } = await import('@/app/api/setup/pi/cache-warming/route');
    const file = path.join(agentDir, 'settings.json');
    const saved = readFileSync(file);
    const priorVersion = readFileSync(versionFile);
    const post = (cacheWarming: unknown) => POST(new Request('http://localhost/api/setup/pi/cache-warming', {
      method: 'POST', body: JSON.stringify({ cacheWarming }),
    }));
    try {
      expect((await post('yes')).status).toBe(400);
      writeFileSync(versionFile, '0.85.9');
      invalidateCliCache('pi');
      expect((await post('idle')).status).toBe(409);
      expect(readFileSync(file)).toEqual(saved);
    } finally { writeFileSync(versionFile, priorVersion); invalidateCliCache('pi'); }
  });

  it('launches an o8 worker through the user binary, environment and cwd without granting trust', async () => {
    const launched = await piRuntime.launch({ cwd, prompt: 'Fixture task' });
    if (launched.sessionKey) ownedKeys.push(launched.sessionKey);
    expect(launched).toMatchObject({ ok: true, sessionKey: expect.stringMatching(/^pi-owned:/) });
    const result = await waitForReceipt(1);
    expect(result).toMatchObject({ cwd, agentDir });
    expect(result.argv).toEqual(['--mode', 'rpc', '--name', path.basename(cwd)]);
    expect(existsSync(path.join(agentDir, 'trusted-projects.json'))).toBe(false);
  });

  it('lists user sessions by cwd and resumes a writable owned copy without changing the source', async () => {
    const listed = (await discovered()).find((item) => item.ownership === 'discovered');
    expect(listed).toMatchObject({ cwd, runtimeId: 'pi', sessionKey: expect.stringMatching(/^pi:/), sessionCapabilities: { canSendInput: true, canInterrupt: false } });
    const result = await piRuntime.resume(listed!.sessionKey, 'Continue fixture');
    if (result.sessionKey) ownedKeys.push(result.sessionKey);
    expect(result).toMatchObject({ ok: true, sessionKey: expect.stringMatching(/^pi-owned:/) });
    const child = await waitForReceipt(2);
    const copy = child.argv[child.argv.indexOf('--session') + 1];
    expect(child.argv).toContain('--session');
    expect(child).toMatchObject({ cwd, agentDir });
    expect(copy).not.toBe(sessionFile);
    expect(copy.startsWith(process.env.O8_OWNED_PI_ROOT! + path.sep)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toContain('fixture-resumed');
    expect(readFileSync(sessionFile, 'utf8')).toBe(savedBytes);
    expect(statSync(sessionFile).mtimeMs).toBe(savedMtime);
    expect((await discovered()).find((item) => item.sessionKey === result.sessionKey)).toMatchObject({ ownership: 'owned', cwd });
  });

  it('honours the environment session directory ahead of settings and rejects arbitrary session paths', async () => {
    const secondCwd = path.join(root, 'second-project');
    mkdirSync(secondCwd);
    const secondFile = path.join(sessions, 'second.jsonl');
    writeFileSync(secondFile, JSON.stringify({ type: 'session', cwd: secondCwd }) + '\n');
    expect((await discovered()).filter((item) => item.ownership === 'discovered').map((item) => item.cwd)).toEqual([cwd, secondCwd]);
    const override = path.join(root, 'override');
    mkdirSync(override);
    writeFileSync(path.join(override, 'override.jsonl'), savedBytes);
    process.env.PI_CODING_AGENT_SESSION_DIR = override;
    try {
      const listed = (await discovered()).filter((item) => item.ownership === 'discovered');
      expect(listed).toHaveLength(1);
      expect(listed[0].sessionKey).toContain('override.jsonl');
      expect(await piRuntime.resume(`pi:${sessionFile}`, 'Do not open')).toMatchObject({ ok: false });
    } finally {
      process.env.PI_CODING_AGENT_SESSION_DIR = '';
      rmSync(secondFile);
    }
  });

  it('rereads a listed session file once it changes', async () => {
    const thirdCwd = path.join(root, 'third-project');
    mkdirSync(thirdCwd);
    const thirdFile = path.join(sessions, 'third.jsonl');
    const header = JSON.stringify({ type: 'session', cwd: thirdCwd }) + '\n';
    writeFileSync(thirdFile, header);
    try {
      const named = async () => (await discovered()).find((item) => item.cwd === thirdCwd)?.displayName;
      expect(await named()).toBe('Pi: third-project');
      writeFileSync(thirdFile, header + JSON.stringify({ type: 'session_info', name: 'Renamed fixture' }) + '\n');
      expect(await named()).toBe('Renamed fixture');
    } finally {
      rmSync(thirdFile);
    }
  });

  it('bounds settings and session reads and refuses links to auth files', async () => {
    const settingsFile = path.join(agentDir, 'settings.json');
    const settings = readFileSync(settingsFile);
    const fallback = path.join(agentDir, 'sessions', '--fixture--');
    mkdirSync(fallback, { recursive: true });
    const largeSession = path.join(fallback, 'large.jsonl');
    writeFileSync(largeSession, savedBytes);
    truncateSync(largeSession, 16 * 1024 * 1024 + 1);
    writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'oversized', padding: 'x'.repeat(65_536) }));
    try {
      const status = await detectRuntimeAuthStatus('pi');
      expect(status).toMatchObject({ piSetup: { detected: true, provider: undefined, sessions: 1 } });
      expect(await piRuntime.resume(`pi:${largeSession}`, 'Too large')).toMatchObject({ ok: false });
      rmSync(settingsFile);
      symlinkSync(path.join(agentDir, 'auth.json'), settingsFile);
      symlinkSync(path.join(agentDir, 'auth.json'), path.join(fallback, 'auth-link.jsonl'));
      const linked = await detectRuntimeAuthStatus('pi');
      expect(linked).toMatchObject({ piSetup: { credentialsPresent: true, provider: undefined, sessions: 1 } });
      expect(JSON.stringify(linked)).not.toContain(marker);
    } finally {
      rmSync(settingsFile, { force: true });
      writeFileSync(settingsFile, settings);
    }
  });

  it('counts extension entry points and skill roots rather than nested helper files', async () => {
    const extension = path.join(agentDir, 'extensions', 'plugin');
    const packaged = path.join(agentDir, 'extensions', 'package');
    const skill = path.join(agentDir, 'skills', 'parent');
    for (const dir of [extension, packaged, path.join(skill, 'child')]) mkdirSync(dir, { recursive: true });
    for (const name of ['index.ts', 'index.js', 'helper.ts']) writeFileSync(path.join(extension, name), 'export default () => {};');
    for (const name of ['first.ts', 'second.ts', 'helper.ts']) writeFileSync(path.join(packaged, name), 'export default () => {};');
    writeFileSync(path.join(packaged, 'package.json'), JSON.stringify({ pi: { extensions: ['./first.ts', './second.ts'] } }));
    writeFileSync(path.join(skill, 'SKILL.md'), 'Parent skill');
    writeFileSync(path.join(skill, 'child', 'SKILL.md'), 'Nested support file');
    try {
      expect(await detectRuntimeAuthStatus('pi')).toMatchObject({ piSetup: { extensions: 4, skills: 2 } });
    } finally {
      for (const dir of [extension, packaged, skill]) rmSync(dir, { recursive: true, force: true });
    }
  });
});
