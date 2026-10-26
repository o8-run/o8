import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretToolResult } from '@/lib/providers/child-process';

// An in-memory stand-in for libsecret's secret-tool, keyed on its attribute argv.
const fake = vi.hoisted(() => ({
  items: new Map<string, string>(),
  unavailable: false,
  calls: [] as string[][],
}));
vi.mock('@/lib/providers/child-process', () => ({
  spawn: () => { throw new Error('the macOS security CLI must not run on Linux'); },
  runSecretTool: async (args: string[], input = ''): Promise<SecretToolResult> => {
    fake.calls.push(args);
    if (fake.unavailable) return { code: 1, stdout: '', stderr: 'secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n' };
    const [command, ...rest] = args;
    const attributes = (command === 'store' ? rest.slice(1) : rest).join('\0');
    if (command === 'store') { fake.items.set(attributes, input); return { code: 0, stdout: '', stderr: '' }; }
    const value = fake.items.get(attributes);
    if (command === 'clear') fake.items.delete(attributes);
    if (value === undefined) return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: command === 'lookup' ? value : '', stderr: '' };
  },
}));

const { OsPlanStore, platformEntries, secretServiceEntries } = await import('./credential-store');
const { emptyPlanRecord } = await import('./types');

let directory = '';
let platform: PropertyDescriptor | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'o8-plan-linux-'));
  fake.items.clear(); fake.calls.length = 0; fake.unavailable = false;
  platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
});
afterEach(async () => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  await rm(directory, { recursive: true, force: true });
});

describe('ChatGPT plan credentials on Linux', () => {
  it('selects the Secret Service on Linux and no store elsewhere', () => {
    expect(platformEntries('linux')).toBe(secretServiceEntries);
    expect(() => platformEntries('win32')).toThrow(expect.objectContaining({ code: 'secure_store_unavailable' }));
  });

  it('round-trips and replaces a record through the Secret Service, leaving no credential files', async () => {
    const store = new OsPlanStore(directory);
    const owner = `fixture-${randomUUID()}`;
    expect(await store.read(owner)).toEqual(emptyPlanRecord(owner));
    const record = emptyPlanRecord(owner);
    record.registrations.push({ id: randomUUID(), issuer: 'https://fixture.example.invalid', subject: 's', clientId: 'c', label: 'Synthetic', tokens: { accessToken: `a-${'x'.repeat(3_000)}`, refreshToken: 'r', idToken: 'i', expiresAt: 1, scopes: [] } });
    await store.locked(owner, () => store.write(owner, record));
    expect(await new OsPlanStore(directory).read(owner)).toEqual(record);
    const chunks = fake.items.size;

    record.generation += 1; record.registrations[0].tokens = null;
    await store.locked(owner, () => store.write(owner, record));
    expect(await new OsPlanStore(directory).read(owner)).toEqual(record);
    // The previous version's chunks were cleared after the new index was published.
    expect(fake.items.size).toBeLessThan(chunks);
    expect(fake.calls.every((args) => !args.some((arg) => arg.includes('fixture.example')))).toBe(true);
    expect(await readdir(directory)).toEqual(['host-id']);
  });

  it('reports secure_store_unavailable with Linux guidance when no Secret Service runs', async () => {
    fake.unavailable = true;
    const store = new OsPlanStore(directory);
    await expect(store.read('owner')).rejects.toMatchObject({ code: 'secure_store_unavailable', message: expect.stringContaining('Secret Service') });
    await expect(store.write('owner', emptyPlanRecord('owner'))).rejects.toMatchObject({ code: 'secure_store_unavailable' });
    expect(await readdir(directory)).toEqual(['host-id']);
  });
});
