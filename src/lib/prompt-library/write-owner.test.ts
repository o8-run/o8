import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ getSqlite: vi.fn(() => { throw Error('Unexpected database access'); }) }));
import { getSqlite } from '@/lib/db';
import { createPromptLibraryEntry, updatePromptLibraryEntry, deletePromptLibraryEntry, recordPromptLibraryUse, importPromptLibrarySources } from './store';
import { refuseNodePromptWrite } from './write-owner';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('fences every Node writer, including internal callers and empty import, before database access', async () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  for (const write of [() => createPromptLibraryEntry({ title: 'x', body: 'x' }), () => updatePromptLibraryEntry('id', {}), () => deletePromptLibraryEntry('id'), () => recordPromptLibraryUse('id'), () => importPromptLibrarySources({ sources: [] })]) {
    expect(write).toThrow('Saved prompt writes belong to o8d');
  }
  expect(getSqlite).not.toHaveBeenCalled();
  const refusal = refuseNodePromptWrite()!; expect(refusal.status).toBe(503);
  expect(refusal.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(await refusal.json()).toMatchObject({ error: { code: 'prompt_library_native_owner' } });
});
it('leaves classic route behavior selected', () => {
  vi.stubEnv('O8_API_FRONT_DOOR', '0'); expect(refuseNodePromptWrite()).toBeNull();
});
