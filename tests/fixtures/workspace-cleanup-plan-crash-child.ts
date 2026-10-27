import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
const [planId, entryId, stage, proof] = process.argv.slice(2);
if (!planId || !entryId || !stage || !proof) throw new Error('Crash fixture requires plan, entry, stage and proof.');
const runtimeRequire = createRequire(path.join(process.cwd(), 'package.json'));
const processes = runtimeRequire('node:child_process') as typeof import('node:child_process');
const originalSpawn = processes.spawn;
const originalExecFile = processes.execFile;
let armed = false;
let mutated = false;
type Claim = { state: string; source_path: string; claim_path: string; authority_json: string };
const claim = () => sqlite.prepare(`SELECT state, source_path, claim_path, authority_json
  FROM workspace_exact_claims WHERE json_extract(authority_json, '$.reviewedCleanup.planId') = ?
    AND json_extract(authority_json, '$.reviewedCleanup.entryId') = ? LIMIT 1`).get(planId, entryId) as Claim | undefined;
function crash(point: string) {
  writeFileSync(proof, point, { flag: 'wx' });
  process.kill(process.pid, 'SIGKILL');
}
// execFile's internal spawn does not call the exported spawn function. Observe
// its real close event before callback/promise consumers can journal the rename.
const spawnedOptions = new WeakMap<import('node:child_process').ChildProcess, import('node:child_process').SpawnOptions>();
const originalEmit = processes.ChildProcess.prototype.emit;
processes.ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (armed && event === 'close') {
    const current = claim();
    const options = spawnedOptions.get(this);
    if (current?.state === 'prepared' && !existsSync(current.source_path) && existsSync(current.claim_path)) {
      if (stage === 'rename-before-journal') crash('rename-before-journal');
      if (stage === 'restore-intent' && !mutated) {
        writeFileSync(path.join(current.claim_path, 'unreviewed-crash.log'), 'must survive a restoration crash');
        mutated = true;
      }
    }
    if (stage === 'manifest-capture' && current?.state === 'claimed'
      && options?.cwd === current.claim_path && options.env?.O8_PURGE_CAPTURE_ONLY === '1') crash('manifest-capture');
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
};
function beforeLaunch() {
  const current = armed ? claim() : undefined;
  if (current) {
    const restoring = JSON.parse(current.authority_json).reviewedCleanupRestore === true;
    const finalization = sqlite.prepare('SELECT state FROM workspace_exact_finalizations WHERE operation_id = (SELECT operation_id FROM workspace_exact_claims WHERE claim_path = ?)')
      .get(current.claim_path) as { state: string } | undefined;
    if (stage === 'restore-intent' && restoring) crash('restore-intent');
    if (stage === 'purge-admission' && current.state === 'purging') crash('purge-admission');
    if (stage === 'final-admission' && finalization?.state === 'admitted' && existsSync(current.claim_path)) crash('final-admission');
  }
  return current;
}
processes.execFile = ((...args: unknown[]) => {
  beforeLaunch();
  return Reflect.apply(originalExecFile, processes, args);
}) as typeof originalExecFile;
processes.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  const current = beforeLaunch();
  const options = args[2];
  if (current) {
    if (stage === 'partial-delete' && current.state === 'purging' && options?.cwd === current.claim_path
      && options.env?.O8_PURGE_EXPECTED_DEVICE && options.env.O8_PURGE_CAPTURE_ONLY !== '1') {
      options.env = { ...options.env, NODE_ENV: 'test', O8_TEST_PURGE_STOP_MARKER: `${proof}.unlink` };
    }
  }
  const child = originalSpawn(...args);
  if (options) spawnedOptions.set(child, options);
  if (armed) {
    if (stage === 'partial-delete' && options?.env?.O8_TEST_PURGE_STOP_MARKER && child.pid) {
      const timer = setInterval(() => {
        if (!existsSync(`${proof}.unlink`)) return;
        clearInterval(timer);
        process.kill(child.pid!, 'SIGKILL');
        crash('partial-delete');
      }, 10);
      child.once('close', () => clearInterval(timer));
    }
  }
  return child;
}) as typeof originalSpawn;
syncBuiltinESMExports();

const { NextRequest } = await import('next/server');
const { getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { readCleanupPlan } = await import('@/lib/worktree/cleanup-plan');
const route = await import('@/app/api/orchestrator/workspace/maintenance/route');
const sqlite = getSqlite();
const plan = readCleanupPlan(planId);
armed = true;
const response = await route.POST(new NextRequest('http://localhost/api/orchestrator/workspace/maintenance', {
  method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'execute', planId, fingerprint: plan.fingerprint,
    selection: [entryId] }),
}));
throw new Error(`Crash seam was not reached: ${response.status} ${await response.text()}`);

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
