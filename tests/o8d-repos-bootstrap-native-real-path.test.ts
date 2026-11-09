import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

type Bootstrap = {
  initialized?: boolean; initialCommit?: boolean; scaffolded?: boolean; kind?: string; committed?: boolean;
  filesWritten?: string[]; skippedFiles?: string[]; repoPath?: string; repo?: { localPath?: string }; projectId?: unknown;
};

// The path-dependent fields are checked against each target; everything else must match the TS answer.
function shape(body: Bootstrap, target: string): unknown {
  expect([body.repoPath, body.repo?.localPath]).toEqual([target, target]);
  const { repoPath: _path, repo: _repo, projectId, ...rest } = body;
  return { ...rest, projectId: typeof projectId };
}

const subjects = (repo: string) => execFileSync('git', ['-C', repo, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');

// The project dialog's new-repository and scaffold writes, served by the WS listener with
// Next stopped: the same answers as the TS handlers in this process on the same data
// directory, on sibling folders so each side starts from an empty target.
it.skipIf(process.platform === 'win32')('initializes and scaffolds repositories natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-repos-bootstrap-')));
  // The data directory is itself a git checkout once the server starts, so targets live beside it.
  const targets = realpathSync(mkdtempSync(join(tmpdir(), 'o8-repos-targets-')));
  const device = 'repos-bootstrap-fixture-device-0123456789abcdef';
  const worker = 'repos-bootstrap-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  const polled: string[] = [];
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const path of ['/api/panel/repos/init', '/api/panel/repos/scaffold']) {
      const body = { path: join(targets, 'refused'), repoPath: join(targets, 'refused'), kind: 'node' };
      expect([path, (await send('POST', path, forged, body)).status]).toEqual([path, 401]);
      for (const token of [device, worker]) {
        expect([path, (await send('POST', path, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([path, 403]);
      }
    }
    expect(existsSync(join(targets, 'refused'))).toBe(false);

    // The TS handlers publish their realtime change to this server, never to a default port.
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      WS_TOKEN: server.token, CORTEX_REALTIME_INTERNAL_ORIGIN: origin });
    delete process.env.O8_DATA_DIR;
    const init = await import('@/app/api/panel/repos/init/route');
    const scaffold = await import('@/app/api/panel/repos/scaffold/route');
    const handlers = { '/api/panel/repos/init': init.POST, '/api/panel/repos/scaffold': scaffold.POST } as const;
    const compare = async (path: keyof typeof handlers, nativeBody: unknown, tsBody: unknown = nativeBody) => {
      const native = await send('POST', path, operator, nativeBody);
      const ts = await handlers[path](new NextRequest(`http://127.0.0.1${path}`, { method: 'POST',
        headers: { ...operator, 'content-type': 'application/json' }, body: JSON.stringify(tsBody) }));
      expect([path, native.status, native.headers.get('cache-control')]).toEqual([path, ts.status, ts.headers.get('cache-control')]);
      return [await native.json(), await ts.json()] as [Bootstrap, Bootstrap];
    };

    // Refusals match and create nothing.
    for (const [path, body] of [
      ['/api/panel/repos/init', {}], ['/api/panel/repos/init', { path: '   ' }],
      ['/api/panel/repos/scaffold', {}], ['/api/panel/repos/scaffold', { repoPath: join(targets, 'no-kind') }],
      ['/api/panel/repos/scaffold', { repoPath: join(targets, 'bad-kind'), kind: 'cobol' }],
    ] as const) {
      const [native, ts] = await compare(path, body);
      expect([path, native]).toEqual([path, ts]);
    }
    expect([existsSync(join(targets, 'no-kind')), existsSync(join(targets, 'bad-kind'))]).toEqual([false, false]);

    // A new repository, then the same folder again, then a folder inside it.
    const nativeRepo = join(targets, 'native-init');
    const tsRepo = join(targets, 'ts-init');
    polled.push(tsRepo);
    for (const expected of [{ initialized: true, initialCommit: true }, { initialized: false, initialCommit: false }]) {
      const [native, ts] = await compare('/api/panel/repos/init', { path: nativeRepo, name: 'Fixture App' }, { path: tsRepo, name: 'Fixture App' });
      expect(shape(native, nativeRepo)).toEqual(shape(ts, tsRepo));
      expect({ initialized: native.initialized, initialCommit: native.initialCommit }).toEqual(expected);
    }
    expect(subjects(nativeRepo)).toEqual(subjects(tsRepo));
    const [nestedNative, nestedTs] = await compare('/api/panel/repos/init', { path: join(nativeRepo, 'nested') }, { path: join(tsRepo, 'nested') });
    expect(nestedNative).toEqual(nestedTs);
    expect(existsSync(join(nativeRepo, 'nested'))).toBe(false);

    // A scaffold writes and commits its files once; the second run skips them all.
    const nativeSite = join(targets, 'native-site');
    const tsSite = join(targets, 'ts-site');
    polled.push(tsSite);
    let written: string[] = [];
    for (const pass of [1, 2]) {
      const [native, ts] = await compare('/api/panel/repos/scaffold', { repoPath: nativeSite, kind: 'static-html', name: 'Fixture Site' },
        { repoPath: tsSite, kind: 'static-html', name: 'Fixture Site' });
      expect(shape(native, nativeSite)).toEqual(shape(ts, tsSite));
      if (pass === 1) {
        written = native.filesWritten ?? [];
        expect([native.scaffolded, native.committed, written.length > 0]).toEqual([true, true, true]);
      } else {
        expect([native.scaffolded, native.filesWritten, native.skippedFiles]).toEqual([false, [], written]);
      }
    }
    expect(subjects(nativeSite)).toEqual(subjects(tsSite));

    // Both native writes registered the repository in the shared registry.
    const listed = await send('GET', '/api/panel/repos', operator);
    const paths = ((await listed.json()) as { repos: Array<{ localPath: string }> }).repos.map((repo) => repo.localPath);
    expect(paths).toEqual(expect.arrayContaining([nativeRepo, nativeSite]));
  } finally {
    const { stopChangePolling } = await import('@/lib/skeleton/autoscan');
    for (const repo of polled) stopChangePolling(repo);
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
    rmSync(targets, { recursive: true, force: true });
  }
}, 180_000);
