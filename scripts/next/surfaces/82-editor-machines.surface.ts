/** Test-only saved machine for Open in editor: the local server lists one SSH machine. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--editor-machines')) return {};
  writeFileSync(join(dataDir, 'ssh-machines.json'), JSON.stringify({ schema: 'o8/cli/machines/v1', machines: [{
    id: '00000000-0000-4000-8000-0000000000e1', label: 'Editor box', target: 'me@editor-box', port: 22,
    remoteCli: 'o8', sshConfig: null, enabled: true,
  }] }));
  const machines = await import('../../../src/app/api/panel/ssh-machines/route');
  return { routes: { 'GET /api/panel/ssh-machines': machines.GET }, admit: () => 200 };
}
