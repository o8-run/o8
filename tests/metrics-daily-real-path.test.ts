import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-daily-metrics-'));
const fixture = resolve('tests/fixtures/metrics-daily.json');
const capture = join(root, 'request.json');
const transport = join(root, 'transport.mjs');
writeFileSync(transport, `
  import { readFileSync, writeFileSync } from 'node:fs';
  globalThis.fetch = async (url, init) => {
    if (process.env.O8_METRICS_TEST_FAILURE === 'throw') throw new Error(process.env.O8_METRICS_READ_TOKEN);
    if (process.env.O8_METRICS_TEST_FAILURE === 'status') return Response.json({ detail: process.env.O8_METRICS_READ_TOKEN }, { status: 403 });
    writeFileSync(process.env.O8_METRICS_TEST_CAPTURE, JSON.stringify({
      method: init.method, redirect: init.redirect,
      authorizationCorrect: new Headers(init.headers).get('authorization') === 'Bearer ' + process.env.O8_METRICS_READ_TOKEN,
      endpointCorrect: String(url) === process.env.O8_METRICS_READ_URL,
    }));
    return Response.json(JSON.parse(readFileSync(process.env.O8_METRICS_TEST_FIXTURE, 'utf8')));
  };
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawnSync('npm', ['--silent', 'run', 'metrics:daily', '--', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', npm_config_cache: join(root, 'cache'),
      npm_config_update_notifier: 'false', ...extra },
  });
  return { status: child.status, output: child.stdout + child.stderr };
}
function exportWith(change: Record<string, unknown>) {
  const destination = join(root, 'changed.json');
  writeFileSync(destination, JSON.stringify({ ...JSON.parse(readFileSync(fixture, 'utf8')), ...change }));
  return destination;
}
const liveEnv = () => ({
  NODE_OPTIONS: `--import=${transport}`,
  O8_METRICS_READ_URL: 'https://metrics.example.test/v1/telemetry/export',
  O8_METRICS_READ_TOKEN: 'fixture-read-credential-never-printed',
  O8_METRICS_TEST_CAPTURE: capture,
  O8_METRICS_TEST_FIXTURE: fixture,
});

describe('daily metrics through the npm command', () => {
  it('redacts the read bearer embedded in a successful export version', () => {
    const environment = liveEnv();
    const data = JSON.parse(readFileSync(fixture, 'utf8'));
    const changed = exportWith({ events: data.events.map((event: Record<string, unknown>) => ({
      ...event, appVersion: `1.0.0-${environment.O8_METRICS_READ_TOKEN}`,
    })) });
    const result = run(['--date', '2026-10-24'], { ...environment, O8_METRICS_TEST_FIXTURE: changed });
    expect(result.status).toBe(0);
    // Boolean assertions never include a bearer or captured output in a red tail.
    expect(result.output.includes(environment.O8_METRICS_READ_TOKEN)).toBe(false);
    expect(result.output).toContain('| 1.0.0-[REDACTED] |');
  });

  it('never reintroduces a credential through the redaction label', () => {
    const credential = 'REDACTED';
    const data = JSON.parse(readFileSync(fixture, 'utf8'));
    const changed = exportWith({ events: data.events.map((event: Record<string, unknown>) => ({
      ...event, appVersion: `1.0.0-${credential}`,
    })) });
    const result = run(['--date', '2026-10-24'], { ...liveEnv(), O8_METRICS_READ_TOKEN: credential, O8_METRICS_TEST_FIXTURE: changed });
    expect(result.status).toBe(0);
    expect(result.output.includes(credential)).toBe(false);
  });

  it.each([
    { credential: '2026-10-24', args: ['--date', '2026-10-24'], failure: undefined },
    { credential: '1', args: ['--date', '2026-10-24'], failure: undefined },
    { credential: 'O8_METRICS_READ_TOKEN', args: ['--help'], failure: undefined },
    { credential: 'Metrics read failed', args: ['--date', '2026-10-24'], failure: 'throw' },
  ])('redacts credential collisions from all command output ($credential)', ({ credential, args, failure }) => {
    const result = run(args, { ...liveEnv(), O8_METRICS_READ_TOKEN: credential, O8_METRICS_TEST_FAILURE: failure });
    expect(result.output.includes(credential)).toBe(false);
    expect(result.output).toContain('[REDACTED]');
    expect(result.status).toBe(failure ? 1 : 0);
  });

  it.each(['01.0.0', '1.0.0-01', '1.0.0-..', '1.0.0+.', '1.0.0\n'])('rejects malformed printed versions (%j)', (appVersion) => {
    const data = JSON.parse(readFileSync(fixture, 'utf8'));
    const changed = exportWith({ events: data.events.map((event: Record<string, unknown>) => ({ ...event, appVersion })) });
    const result = run(['--date', '2026-10-24'], { ...liveEnv(), O8_METRICS_TEST_FIXTURE: changed });
    expect(result.status).toBe(1);
    expect(result.output).toContain('Invalid metrics export');
    expect(result.output).not.toContain('| App version |');
  });

  it('aggregates complete history by UTC date and app version without identities or network reads', () => {
    const result = run(['--fixture', fixture, '--date', '2026-10-24'], {
      ...liveEnv(), O8_METRICS_TEST_FAILURE: 'throw',
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain('Usage metrics for 2026-10-24 (UTC)');
    expect(result.output).toContain('Fixture data; these are not production numbers.');
    expect(result.output).toContain('| App version | New installs | Daily active installs | First worker launched | First merge | Clean-session rate |');
    expect(result.output).toContain('| 1.0.0 | 1 | 1 | 1 | 1 | 100.0% (1/1) |');
    expect(result.output).toContain('| 1.1.0 | 1 | 3 | 1 | 0 | 50.0% (1/2) |');
    expect(result.output).not.toContain('install-a');
    expect(result.output).not.toContain('fixture-read-credential-never-printed');
  });

  it('places midnight events on the next day and shows no rate without session endings', () => {
    const result = run(['--fixture', fixture, '--date', '2026-10-25']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('| 1.1.0 | 0 | 1 | 0 | 1 | — |');
    expect(result.output).toContain('| 2.0.0 | 1 | 1 | 0 | 0 | — |');
  });

  it('fails clearly when the hosted read endpoint and environment credential are missing', () => {
    const result = run(['--date', '2026-10-24']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('O8_METRICS_READ_URL');
    expect(result.output).toContain('O8_METRICS_READ_TOKEN');
    expect(result.output).toContain('No telemetry read endpoint is implemented in this repository.');
    expect(result.output).not.toContain('| 1.0.0 |');
  });

  it('uses only GET and the environment read credential for a configured export', () => {
    const result = run(['--date', '2026-10-24'], liveEnv());
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
      method: 'GET', redirect: 'error', authorizationCorrect: true, endpointCorrect: true,
    });
    expect(result.output).toContain('| 1.0.0 | 1 | 1 | 1 | 1 | 100.0% (1/1) |');
    expect(result.output).not.toContain('Fixture data');
    expect(result.output).not.toContain('fixture-read-credential-never-printed');
  });

  it('rejects credentials embedded in a read URL without echoing its value', () => {
    rmSync(capture, { force: true });
    const result = run(['--date', '2026-10-24'], {
      ...liveEnv(), O8_METRICS_READ_URL: 'https://metrics.example.test/export?token=fixture-url-credential',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain('Metrics read URL must use HTTPS');
    expect(result.output).not.toContain('fixture-url-credential');
    expect(existsSync(capture)).toBe(false);
  });

  it.each(['throw', 'status'])('does not print credentials from upstream %s failures', (failure) => {
    const result = run(['--date', '2026-10-24'], { ...liveEnv(), O8_METRICS_TEST_FAILURE: failure });
    expect(result.status).toBe(1);
    expect(result.output).toContain('Metrics read failed');
    expect(result.output).not.toContain('fixture-read-credential-never-printed');
  });

  it.each([
    { historyComplete: false },
    { completeThrough: '2026-10-24T12:00:00.000Z' },
  ])('rejects partial history or incomplete days instead of inventing counts', (change) => {
    const result = run(['--fixture', exportWith(change), '--date', '2026-10-24']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('complete history through the end of the requested UTC day');
    expect(result.output).not.toContain('| 1.0.0 |');
  });

  it('rejects conflicting event IDs and missing version metadata', () => {
    const data = JSON.parse(readFileSync(fixture, 'utf8'));
    const conflict = { ...data.events[0], appVersion: '9.0.0' };
    let result = run(['--fixture', exportWith({ events: [...data.events, conflict] }), '--date', '2026-10-24']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Conflicting event identifiers');
    result = run(['--fixture', exportWith({ events: [{ ...data.events[0], appVersion: undefined }] }), '--date', '2026-10-24']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Invalid metrics export');
  });

  it('validates dates and represents an empty day without a zero-percent success claim', () => {
    expect(run(['--fixture', fixture, '--date', '2026-02-30']).status).toBe(1);
    const result = run(['--fixture', fixture, '--date', '2026-10-22']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('No observed usage for this date.');
    expect(result.output).not.toContain('0.0%');
    expect(existsSync(fixture)).toBe(true);
  });
});
