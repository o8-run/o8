import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { OsPlanStore, secretServiceEntries } from './credential-store';
import { emptyPlanRecord } from './types';

// Opt-in: run inside a disposable session, for example
// dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock --components=secrets; O8_TEST_SECRET_SERVICE_PLAN=1 npm run test:integration -- native-secret-service'
it.skipIf(process.platform !== 'linux' || process.env.O8_TEST_SECRET_SERVICE_PLAN !== '1')('round-trips and replaces a large synthetic record in the Linux Secret Service without credential files', async () => {
  const owner = `fixture-plan-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'o8-plan-secret-service-fixture-'));
  const store = new OsPlanStore(directory, secretServiceEntries);
  const command = promisify(execFile);
  const account = createHash('sha256').update(JSON.stringify(['v1', await store.hostId(), owner])).digest('hex');
  try {
    const record = emptyPlanRecord(owner);
    record.registrations.push({ id: randomUUID(), issuer: 'https://fixture.example.invalid', subject: 'fixture-subject', clientId: 'fixture-client', label: 'Synthetic account', tokens: { accessToken: `fixture-access-${'x'.repeat(6_000)}`, refreshToken: `fixture-refresh-${'y'.repeat(6_000)}`, idToken: `fixture-id-${'z'.repeat(6_000)}`, expiresAt: 1, scopes: [] } });
    await store.locked(owner, async () => { await store.write(owner, record); expect(await store.read(owner)).toEqual(record); });
    record.registrations[0].tokens = null; record.generation += 1;
    await store.locked(owner, () => store.write(owner, record));
    expect(await new OsPlanStore(directory, secretServiceEntries).read(owner)).toEqual(record);
    expect(await readdir(directory)).toEqual(['host-id']);
  } finally {
    const index = await command('secret-tool', ['lookup', 'service', 'ai.o8.chatgpt-plan', 'account', account]).catch(() => null);
    if (index?.stdout) {
      const selected = JSON.parse(index.stdout) as { version: string; count: number };
      for (let part = 0; part < selected.count; part += 1) await command('secret-tool', ['clear', 'service', 'ai.o8.chatgpt-plan', 'account', `${account}-${selected.version}-${part}`]).catch(() => {});
      await command('secret-tool', ['clear', 'service', 'ai.o8.chatgpt-plan', 'account', account]).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
