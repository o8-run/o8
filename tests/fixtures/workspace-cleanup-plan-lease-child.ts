import { writeFileSync } from 'node:fs';
import { withResourceLease } from '../../src/lib/leases/resource-lease-guard';

const [planId, entered] = process.argv.slice(2);
if (!planId || !entered) throw new Error('Fixture requires a plan and receipt path.');
async function main() { await withResourceLease({ resource: `workspace-cleanup-plan:${planId}`,
  owner: { id: `cleanup-fixture:${planId}`, label: 'Competing cleanup fixture', pid: process.pid }, actor: 'operator' }, async () => {
  writeFileSync(entered, 'exact plan lease acquired');
  const timer = setInterval(() => {}, 1000);
  try { await new Promise<void>(() => {}); } finally { clearInterval(timer); }
});
}
void main().catch(error => { console.error('[cleanup-plan-fixture]', error); process.exitCode = 1; });
