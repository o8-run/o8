export {};
async function main() {
  // Process-only fixture: never starts an app, server, or worker.
  const { initializeProjectsLedger } = await import('@/lib/repos/projects');
  const { currentLaneMergePolicy } = await import('@/lib/lane/dogfood-guard');
  const { getSqlite, closeDb } = await import('@/lib/db');
  const mode = process.argv[2];
  if (mode === 'next-first') getSqlite();
  await initializeProjectsLedger();
  const policy = currentLaneMergePolicy('default');
  const projectless = getSqlite().prepare('SELECT project_id FROM lanes WHERE project_id IS NULL LIMIT 1').get() as { project_id: null } | undefined;
  if (mode === 'seed') {
    const { createLane } = await import('@/lib/lane/registry');
    const lane = createLane({ repoPath: process.env.O8_DATA_DIR!, branch: 'fixture/projectless', runtime: 'codex' });
    getSqlite().prepare('UPDATE lanes SET project_id = NULL WHERE id = ?').run(lane.id);
  }
  console.log(JSON.stringify({ policy, savedPolicy: currentLaneMergePolicy('saved').mode, oldPolicy: currentLaneMergePolicy('old').mode, projectlessPolicy: currentLaneMergePolicy(projectless?.project_id).mode, saved: getSqlite().prepare("SELECT value FROM app_state WHERE key = 'project-merge-mode:default'").get() ?? null }));
  closeDb();
}
void main();
