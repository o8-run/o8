/** Second disposable workspace for shell switching; read through production routes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function seedShellWorkspace(dataDir: string, root: string, index = 1) {
  const repo = join(root, index === 1 ? 'second-repo' : `workspace-${index}`);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const seed = { id: index === 1 ? 'thoughts-shell-second' : `thoughts-shell-${index}`, title: index === 1 ? 'Second workspace session' : `Workspace ${index}`, messages: [
    { id: 'shell-second-ready', role: 'assistant', content: 'Second workspace ready', timestamp: 1790812800000 },
  ] };
  writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
    repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: true, savedAt: '2026-10-01T00:00:00.000Z' }));
  return seed;
}
