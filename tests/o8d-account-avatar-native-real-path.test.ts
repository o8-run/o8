import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The rail's account photo, served by the WS listener with Next stopped: the same answers as
// the TS handler in this process on the same data directory. Every case resolves without a
// photo fetch (no identity, no row, a stored URL off the photo hosts, or signed out), so no
// request leaves the machine.
it.skipIf(process.platform === 'win32')('serves the account photo route natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-account-avatar-')));
  const device = 'account-avatar-fixture-device-0123456789abcdef';
  const worker = 'account-avatar-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = '/api/panel/account/avatar';
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (headers: Record<string, string>) => fetch(`${origin}${path}`, { headers });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await send(forged)).status).toBe(401);
    for (const token of [device, worker]) {
      expect((await send({ ...forged, authorization: `Bearer ${token}` })).status).toBe(403);
    }

    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      WS_TOKEN: server.token, CORTEX_REALTIME_INTERNAL_ORIGIN: origin });
    delete process.env.O8_DATA_DIR;
    const avatar = await import('@/app/api/panel/account/avatar/route');
    const { createUser, updateUser } = await import('@/lib/db/users');

    const answers: string[] = [];
    const compare = async (label: string) => {
      const native = await send(operator);
      const ts = await avatar.GET(new Request(`http://127.0.0.1${path}`, { headers: operator }));
      const read = async (response: Response) => [response.status, response.headers.get('cache-control'),
        response.headers.get('content-type'), (await response.arrayBuffer()).byteLength];
      const nativeAnswer = await read(native);
      expect([label, ...nativeAnswer]).toEqual([label, ...await read(ts)]);
      answers.push(`${label} ${nativeAnswer[0]}`);
    };

    await compare('no identity');
    writeFileSync(join(directory, 'active-identity'), 'user_fixture_unmatched\n');
    await compare('no account row');
    const user = createUser({ clerkUserId: 'user_fixture_owner', email: 'owner@example.invalid' });
    await compare('one row, no photo');
    updateUser(user.id, { avatarUrl: 'https://photos.example.invalid/owner.png' });
    await compare('one row, photo off the known hosts');
    writeFileSync(join(directory, 'active-identity'), 'user_fixture_owner\n');
    updateUser(user.id, { avatarUrl: 'http://avatars.githubusercontent.com/u/1' });
    await compare('matched row, plain http photo');
    updateUser(user.id, { avatarUrl: 'https://avatars.githubusercontent.com/u/1' });
    writeFileSync(join(directory, 'auth-signed-out-at'), String(Math.floor(Date.now() / 1_000)));
    await compare('signed out');
    unlinkSync(join(directory, 'auth-signed-out-at'));
    updateUser(user.id, { avatarUrl: 'not a url' });
    await compare('matched row, unparsable photo');
    expect(answers.every(answer => answer.endsWith(' 204')), answers.join(', ')).toBe(true);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
