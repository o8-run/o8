// Owned production WS fixture for the window's inventory-notice regression.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSessionFixture } from '../../scripts/o8d/parity';
import { startParityReference } from './ws-parity-server';
async function main() {
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-project-refresh-')));
await seedSessionFixture(root);
const server = await startParityReference({ directory: root, productFrontDoor: true, nativeHttp: true, o8d: false });
const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
async function post(path: string, body: unknown) {
  const response = await fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error('Fixture route refused: ' + path + ' ' + response.status);
  return response.json();
}
const ledger = await post('/api/panel/projects', { name: 'Inventory A' });
const history = await (await fetch(origin + '/api/v2/chat-history?tabId=thoughts-review', { headers: { authorization: 'Bearer ' + server.token } })).json();
console.log(JSON.stringify({ origin, root, token: server.token, project: ledger.activeProjectId, repo: history.repoPath }));
let stopped = false;
async function stop() { if (stopped) return; stopped = true; await server.stop(); rmSync(root, { recursive: true, force: true }); }
process.stdin.resume();
process.stdin.on('end', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
