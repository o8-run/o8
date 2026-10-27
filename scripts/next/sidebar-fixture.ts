/** Authored disposable sidebar records; production routes remain the oracle. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function installSidebarRuntime(dataDir: string, repo: string) {
  await (await import('./pane-fixture')).installPaneRuntime(dataDir, repo, false, 'pi-builtin');
  const { getRuntime } = await import('../../src/lib/runtimes');
  const runtime = getRuntime('pi-builtin')!;
  const discover = runtime.discoverSessions.bind(runtime);
  Object.defineProperty(runtime, 'discoverSessions', { value: async () =>
    existsSync(join(dataDir, 'owned-pi-builtin', 'grid-runtime', 'session.json')) ? discover() : [], configurable: true });
}

export function seedSidebar(dataDir: string, root: string) {
  const repos = ['sidebar-alpha', 'sidebar-beta'].map(name => join(root, name));
  for (const repo of repos) mkdirSync(repo);
  const seeds = Array.from({ length: 2000 }, (_, index) => {
    const id = `thoughts-sidebar-${String(index).padStart(4, '0')}`;
    const seed = { id, title: `Sidebar thread ${index}`, messages: [
      { id: `${id}-user`, role: 'user', content: 'Fixture question', timestamp: 1790812800000 + index * 1000 },
      { id: `${id}-answer`, role: 'assistant', content: index % 5 === 0 ? '' : 'Fixture answer', timestamp: 1790812800001 + index * 1000 },
    ] };
    writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({ ...seed,
      repoPath: repos[index % 2], backend: 'pi', model: 'pi', orchestratorVisible: true,
      orchestratorTerminalStatus: index % 7 === 0 ? 'failed' : undefined,
      savedAt: new Date(1790812800001 + index * 1000).toISOString() }));
    return seed;
  });
  const unassigned = { id: 'thoughts-unassigned', title: 'Unassigned fixture chat', messages: [
    { id: 'unassigned-user', role: 'user', content: 'Unassigned question', timestamp: 1790812800000 },
    { id: 'unassigned-answer', role: 'assistant', content: 'Unassigned answer', timestamp: 1790812800001 },
  ] };
  writeFileSync(join(dataDir, 'chat-history', `${unassigned.id}.json`), JSON.stringify({ ...unassigned,
    backend: 'pi', model: 'pi', orchestratorVisible: true, savedAt: '2026-10-01T00:00:00.001Z' }));
  return [...seeds, unassigned];
}
