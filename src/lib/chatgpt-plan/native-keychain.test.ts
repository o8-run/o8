import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { OsPlanStore } from './credential-store';
import { emptyPlanRecord } from './types';

it.skipIf(process.platform !== 'darwin' || process.env.O8_TEST_KEYCHAIN_PLAN !== '1')('round-trips and replaces a large synthetic record in the actual OS store without credential files', async () => {
  const owner = `fixture-plan-${randomUUID()}`;
  const accounts = new Set([createHash('sha256').update(owner).digest('hex')]);
  const directory = await mkdtemp(join(tmpdir(), 'o8-plan-keychain-fixture-'));
  const second = await mkdtemp(join(tmpdir(), 'o8-plan-keychain-fixture-'));
  const store = new OsPlanStore(directory);
  const other = new OsPlanStore(second);
  const command = promisify(execFile);
  try {
    for (const profile of [store, other]) accounts.add(createHash('sha256').update(JSON.stringify(['v1', await profile.hostId(), owner])).digest('hex'));
    const record = emptyPlanRecord(owner);
    record.registrations.push({ id: randomUUID(), issuer: 'https://fixture.example.invalid', subject: 'fixture-subject', clientId: 'fixture-client', label: 'Synthetic account', tokens: { accessToken: `fixture-access-${'x'.repeat(6_000)}`, refreshToken: `fixture-refresh-${'y'.repeat(6_000)}`, idToken: `fixture-id-${'z'.repeat(6_000)}`, expiresAt: 1, scopes: [] } });
    await store.locked(owner, async () => { await store.write(owner, record); expect(await store.read(owner)).toEqual(record); });
    expect(await other.read(owner)).toEqual(emptyPlanRecord(owner));
    const independent = emptyPlanRecord(owner); independent.generation = 17;
    await other.locked(owner, () => other.write(owner, independent));
    expect(await new OsPlanStore(directory).read(owner)).toEqual(record);
    record.registrations[0].tokens = null; record.generation += 1;
    await store.locked(owner, async () => { await store.write(owner, record); expect(await new OsPlanStore(directory).read(owner)).toEqual(record); });
    expect(await new OsPlanStore(second).read(owner)).toEqual(independent);
    await writeFile(join(second, 'host-id'), await store.hostId());
    let entered = false;
    let pending: Promise<void> | undefined;
    await store.locked(owner, async () => {
      pending = other.locked(owner, async () => { entered = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(entered).toBe(false);
    });
    await pending; expect(entered).toBe(true);
    await store.hostId(); expect(await readdir(directory)).toEqual(['host-id']);
  } finally {
    for (const account of accounts) {
      const index = await command('/usr/bin/security', ['find-generic-password', '-a', account, '-s', 'ai.o8.chatgpt-plan', '-w']).catch(() => null);
      if (index) {
        const selected = JSON.parse(index.stdout) as { version: string; count: number };
        for (let part = 0; part < selected.count; part += 1) await command('/usr/bin/security', ['delete-generic-password', '-a', `${account}-${selected.version}-${part}`, '-s', 'ai.o8.chatgpt-plan']);
        await command('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', 'ai.o8.chatgpt-plan']);
      }
    }
    await rm(second, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
