import type Database from 'better-sqlite3';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

export async function seedMcpScaleFixture(options: {
  directory: string;
  sqlite: Database.Database;
  initializeRepo: (directory: string) => Promise<void>;
}) {
  const sqlite = options.sqlite;
  if (relative(realpathSync(options.directory), realpathSync(sqlite.name)) !== 'cortex-ide.db') {
    throw new Error('Refusing scale seeding outside the owned fixture database');
  }
  const [{ recordMission }, { normalizeOrchestratorMissionState }, { writeOrchestratorControlPlaneState }, { listReposFresh }] = await Promise.all([
    import('@/lib/db/missions-store'), import('@/lib/orchestrator/store'),
    import('@/lib/orchestrator/control-plane'), import('@/lib/repos/registry'),
  ]);
  const repos: Array<{ id: string; name: string; localPath: string; remoteUrl: null;
    defaultBranch: string; isGitRepo: boolean; addedAt: string; lastOpenedAt: null }> = [];
  const projects: Array<{ id: string; name: string; repoPaths: string[]; createdAt: string }> = [];
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  for (let index = 0; index < 50; index += 1) {
    const localPath = join(options.directory, `scale-repo-${index}`);
    mkdirSync(localPath, { recursive: true });
    await options.initializeRepo(localPath);
    repos.push({ id: `scale-repo-${index}`, name: `Repository ${index}`, localPath,
      remoteUrl: null, defaultBranch: 'main', isGitRepo: true,
      addedAt: new Date(now - (index + 1) * 60_000).toISOString(), lastOpenedAt: null });
  }
  for (let index = 0; index < 10; index += 1) {
    projects.push({ id: `scale-project-${index}`, name: `Project ${index}`,
      repoPaths: repos.slice(index * 5, index * 5 + 5).map((repo) => repo.localPath),
      createdAt: timestamp });
  }
  writeFileSync(join(options.directory, 'repos.json'), JSON.stringify({ version: 1, repos }));
  writeFileSync(join(options.directory, 'projects.json'), JSON.stringify({ activeProjectId: projects[0].id, projects }));
  await listReposFresh();

  const insertProject = sqlite.prepare('INSERT INTO projects (id, name, slug, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const linkRepo = sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, role, suggestion_origin, added_at) VALUES (?, ?, ?, ?, ?)');
  const insertLane = sqlite.prepare(`INSERT INTO lanes
    (id, project_id, label, repo_path, branch, base_branch, runtime, session_key,
     packet_id, status, ownership, last_heartbeat_at, created_at, updated_at, last_event_at, last_event_label)
    VALUES (?, ?, ?, ?, ?, 'main', 'codex', ?, ?, ?, 'managed', ?, ?, ?, ?, ?)`);
  let packetIndex = 0;
  const currentMission = sqlite.transaction(() => {
    let stateToFocus: ReturnType<typeof normalizeOrchestratorMissionState> | undefined;
    // This is isolated fixture state. Keep the application schema and use its
    // mission normalizer/store; bulk lane rows avoid launching any workers.
    sqlite.exec('DELETE FROM lane_events; DELETE FROM lanes; DELETE FROM missions; DELETE FROM project_repos; DELETE FROM projects; DELETE FROM resource_lease_waiters; DELETE FROM resource_leases;');
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index];
      insertProject.run(project.id, project.name, `project-${index}`, now - index, now, index);
      for (const repo of repos.slice(index * 5, index * 5 + 5)) {
        linkRepo.run(project.id, repo.id, 'fullstack', 'manual', now);
      }
    }
    sqlite.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('active_project_id', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(projects[0].id, now);
    for (let missionIndex = 0; missionIndex < 300; missionIndex += 1) {
      const packets = [];
      const historical = missionIndex < 276;
      for (let localIndex = 0; localIndex < (missionIndex < 200 ? 7 : 6); localIndex += 1) {
        const index = packetIndex++;
        const repo = repos[index % repos.length];
        const project = projects[Math.floor(index % repos.length / 5)];
        const laneStatus = historical ? 'completed'
          : (['running', 'reviewing', 'awaiting_input', 'idle'] as const)[index % 4];
        const packetStatus = historical ? 'archived' : laneStatus === 'reviewing' ? 'awaiting_review'
          : laneStatus === 'awaiting_input' ? 'blocked' : laneStatus === 'idle' ? 'queued' : 'running';
        const sessionKey = historical ? null : `fixture:scale-session-${index}`;
        const id = `scale-packet-${index}`;
        const laneId = `scale-lane-${index}`;
        const title = `Persisted packet ${index}`;
        insertLane.run(laneId, project.id, title, repo.localPath, `scale/packet-${index}`,
          sessionKey, id, laneStatus, historical ? null : now, timestamp, timestamp, timestamp, laneStatus);
        packets.push({ id, title, summary: 'Recorded work with a bounded task scope, review criteria, and a durable lane binding.',
          runtime: 'codex', status: packetStatus, queueState: historical ? 'held' : 'queued', releaseState: 'pending',
          projectId: project.id, workspaceTargetPath: repo.localPath, dependencyPacketIds: [],
          ...(historical ? { archivedAt: timestamp } : {}),
          lane: { laneId, sessionKey, repoPath: repo.localPath, runtime: 'codex', branch: `scale/packet-${index}`, status: laneStatus },
        });
      }
      const state = normalizeOrchestratorMissionState({ missionId: `scale-mission-${missionIndex}`,
        prompt: `Persisted mission ${missionIndex}`, summary: `Mission ${missionIndex} with ${packets.length} packets`,
        runtime: 'codex', repoPath: repos[missionIndex % repos.length].localPath, packets });
      recordMission({ id: state.missionId!, repoPath: state.repoPath!, runtime: 'codex', prompt: state.prompt,
        summary: state.summary, constraints: state.constraints ?? '', missionState: state, totalWaves: 1,
        packetMeta: state.packets.map((packet) => ({ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel })),
      });
      if (historical) sqlite.prepare('UPDATE missions SET archived_at = ? WHERE id = ?').run(now, state.missionId);
      stateToFocus = state;
    }
    if (!stateToFocus) throw new Error('Missing scale fixture mission');
    return stateToFocus;
  })();
  writeOrchestratorControlPlaneState(currentMission);

  return {
    missions: (sqlite.prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count,
    packets: (sqlite.prepare("SELECT SUM(json_array_length(mission_state_json, '$.packets')) AS count FROM missions").get() as { count: number }).count,
    lanes: (sqlite.prepare('SELECT COUNT(*) AS count FROM lanes').get() as { count: number }).count,
    repos: (await listReposFresh()).length,
    projects: projects.length,
    archivedMissions: 276,
    currentMissionPackets: currentMission.packets.length,
    currentMissionHasLaneBindings: true,
    activeLanes: (sqlite.prepare("SELECT COUNT(*) AS count FROM lanes WHERE status != 'completed'").get() as { count: number }).count,
  };
}

export function startMcpCpuLoad(enabled: boolean) {
  const blockMs = enabled ? 100 : 0;
  const periodMs = 125;
  const startedAt = performance.now();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let busyMs = 0;
  let cycles = 0;
  const timer = enabled ? setInterval(() => {
    const start = performance.now();
    while (performance.now() - start < blockMs) { /* Synthetic work on this event loop only. */ }
    busyMs += performance.now() - start;
    cycles += 1;
  }, periodMs) : undefined;
  timer?.unref();
  return () => {
    if (timer) clearInterval(timer);
    lag.disable();
    const wallMs = performance.now() - startedAt;
    return { enabled, blockMs, periodMs, requestedDutyPercent: enabled ? 80 : 0, cycles,
      busyMs: Math.round(busyMs), wallMs: Math.round(wallMs),
      observedDutyPercent: Math.round(busyMs / wallMs * 1000) / 10,
      eventLoopDelayMs: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 },
    };
  };
}
