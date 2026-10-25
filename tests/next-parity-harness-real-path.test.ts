import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';

const entry = resolve('scripts/parity/next.mjs');
function run(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10_000 });
}

it('discovers every production registration and both viewport sizes through the harness CLI', () => {
  const result = run('--list');
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(result.stdout);
  const shell = readFileSync('native/o8-next/src/shell.rs', 'utf8');
  const registered = [...shell.matchAll(/^        (\w+): .* = "surfaces\//gm)].map(match => match[1]);
  expect(manifest.surfaces.map((surface: { id: string }) => surface.id).sort()).toEqual(registered.sort());
  expect(manifest.sizes).toEqual([[1024, 720], [1440, 900]]);
});

it('reports signed numeric gaps, preserves missing measurements and never gates on a visual difference', () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-parity-report-'));
  try {
    const input = join(root, 'captures.json');
    const output = join(root, 'output');
    const element = { width: 200, height: 30, fontSize: 13, paddingTop: 8 };
    writeFileSync(input, JSON.stringify([{ surface: 'session', size: [1024, 720],
      native: { sidebar: { ...element, width: 240, fontSize: null } }, web: { sidebar: element },
      images: { native: 'native.png', web: 'web.png', pair: 'pair.png' } }]));
    const result = run('--compare', input, '--output', output);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    const gaps = report.cases[0].elements.sidebar.gap;
    expect(gaps.width).toBe(40);
    expect(gaps.height).toBe(0);
    expect(gaps.fontSize).toBeNull();
    expect(report.cases[0].status).toBe('Partial');
    expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('pair.png');
    writeFileSync(input, JSON.stringify([{ surface: 'session', size: [1024, 720], crash: 'native exited' }]));
    expect(run('--compare', input, '--output', output).status).toBe(1);
    expect(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')).crashes).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('serves the same persisted history and selected desktop tab through production fixture routes', async () => {
  const token = 'fixture-parity-test';
  const host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--shell', '--parity', '--transcript', '--composer'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: host.stdout! });
  try {
    const origin = await new Promise<string>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Parity fixture did not start')), 15_000);
      host.once('error', reject);
      host.once('exit', () => { clearTimeout(timer); reject(new Error('Parity fixture exited')); });
      lines.on('line', line => {
        try {
          const receipt = JSON.parse(line);
          if (receipt.origin) { clearTimeout(timer); ready(receipt.origin); }
        } catch { /* Fixture startup also reports diagnostics. */ }
      });
    });
    const read = async (path: string) => {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const tabs = await read('/api/panel/terminal-state?scope=tile-root');
    expect(tabs.activeTabId).toBe('thoughts-rich');
    expect(tabs.tabs[0]).toMatchObject({ id: 'thoughts-rich', kind: 'orchestrator' });
    const history = await read('/api/mobile/history?sessionKey=llm-chat:thoughts-rich&limit=100');
    expect(history.transcript.length).toBeGreaterThan(0);
    const defaults = await read('/api/panel/operator-defaults');
    expect(defaults.values).toMatchObject({ telemetryConsentAnswered: true, crashReportsEnabled: false, productTelemetryEnabled: false });
  } finally {
    lines.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGTERM');
      const timer = setTimeout(() => host.kill('SIGKILL'), 2000);
      await exited.finally(() => clearTimeout(timer));
    }
  }
}, 30_000);
