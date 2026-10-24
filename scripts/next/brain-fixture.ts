/** Authored memory only. Runtime replacement is installed before route imports. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export async function seedBrainFixture(dataDir: string, repoPath: string) {
  createRequire(resolve('scripts/next/brain-fixture.ts'))('./brain-runtime.cjs');
  const { getSqlite } = await import('../../src/lib/db');
  const { refreshDirectiveFts } = await import('../../src/lib/db/v14-fts5-migration');
  const text = '---\nid: fixture-memory\ntitle: Fixture memory rule\nscope: global\npriority: 8\n---\nFixture memory preserves approvals and read-only retrieval.';
  mkdirSync(join(dataDir, 'directives'), { recursive: true });
  writeFileSync(join(dataDir, 'directives', 'fixture-memory.md'), text);
  refreshDirectiveFts(getSqlite(), 'fixture-memory.md', text);
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'fixture-brain', name: 'Fixture Brain', repoPaths: [repoPath], createdAt: '2026-10-01T00:00:00.000Z' }],
    activeProjectId: 'fixture-brain',
  }));
  // Any accidental external inference fails locally, without an account.
  globalThis.fetch = async () => { throw new Error('External requests are disabled in the Brain fixture'); };
}
