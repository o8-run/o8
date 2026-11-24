/**
 * Source events are kept only while an enabled watch reads that source. A test
 * that reads recorded events defines one first. Import after the test has set
 * its data-directory environment.
 */
export async function watchAutomationSource(kind: 'managed_run' | 'repository' | 'packet', repoPath = '/fixture') {
  const { getSqlite } = await import('@/lib/db');
  getSqlite().prepare(`
    INSERT OR IGNORE INTO automations (id, name, owner, repo_path, runtime, prompt, trigger_kind, watch_source_kind)
    VALUES (?, 'Fixture watch', 'fixture', ?, 'codex', 'Fixture watch.', 'watch', ?)
  `).run(`fixture-watch-${kind}`, repoPath, kind);
}
