import { assertWorkerMemoryCurrent, refreshOwnedWorkerMemory, workerMemoryNeedsRefresh } from '@/lib/dispatch/worker-memory-context';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  AcpClient,
  type AcpInitializeResult,
  type AcpRawNotification,
  type AcpStopReason,
} from '@/lib/acp/client';
import { escalateInterrupt } from '@/lib/runtime/interrupt-escalation';
import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
  readOwnedSessionState,
} from '@/lib/runtimes/shared/owned-session/archive';
import {
  compactText,
  ensureDir,
  isPidAlive,
  metadataPath,
  nowIso,
  pidCommandLine,
  readJsonFile,
  resolveRepoContext,
  validateWorkspace,
  writeJsonFile,
} from '@/lib/runtimes/shared/owned-session/helpers';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { createOwnedAcpPresentation } from './presentation';
import type {
  OwnedAcpRunRecord,
  OwnedAcpRuntimeAdapter,
  OwnedAcpSessionRecord,
  OwnedAcpSessionStore,
} from './types';

const RUNS_DIR = 'runs';
const DEFAULT_TURN_TIMEOUT_MS = 14_400_000;

interface ActiveAcpProcess {
  memoryRevision?: string;
  credentialPolicy: string;
  client: AcpClient;
  sessionId: string;
}

function sessionCapability(result: AcpInitializeResult, capability: string): boolean {
  const sessionCapabilities = result.agentCapabilities?.sessionCapabilities;
  return Boolean(
    sessionCapabilities
    && typeof sessionCapabilities === 'object'
    && !Array.isArray(sessionCapabilities)
    && capability in sessionCapabilities,
  );
}

export function createOwnedAcpSessionStore(adapter: OwnedAcpRuntimeAdapter): OwnedAcpSessionStore {
  const activeProcesses = new Map<string, ActiveAcpProcess>();
  const sessionChains = new Map<string, Promise<unknown>>();
  const root = () => process.env[adapter.rootEnvVar] || adapter.rootDefault;
  const withSession = <T>(surfaceId: string, fn: () => Promise<T>) => (
    chainOnKey(sessionChains, surfaceId, fn)
  );

  async function listDirs(base = root()): Promise<string[]> {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
  }

  async function loadSession(sessionDir: string): Promise<OwnedAcpSessionRecord | null> {
    return readJsonFile<OwnedAcpSessionRecord>(metadataPath(sessionDir)).catch(() => null);
  }

  function rebaseArchivedSession(
    session: OwnedAcpSessionRecord,
    sessionDir: string,
  ): OwnedAcpSessionRecord {
    const rebaseRun = (run: OwnedAcpRunRecord): OwnedAcpRunRecord => ({
      ...run,
      stdoutPath: path.join(sessionDir, RUNS_DIR, path.basename(run.stdoutPath)),
      stderrPath: path.join(sessionDir, RUNS_DIR, path.basename(run.stderrPath)),
    });
    return {
      ...session,
      sessionDir,
      activeRun: session.activeRun ? rebaseRun(session.activeRun) : undefined,
      recentRuns: session.recentRuns.map(rebaseRun),
    };
  }

  async function findSession(
    surfaceId: string,
    includeArchive = true,
  ): Promise<OwnedAcpSessionRecord | null> {
    for (const sessionDir of await listDirs()) {
      const session = await loadSession(sessionDir);
      if (session?.surfaceId === surfaceId) return session;
    }
    if (!includeArchive) return null;
    const archivedPath = await archivedSessionPathForSurfaceId(
      root(),
      surfaceId,
      adapter.surfaceIdPrefix,
    );
    if (!archivedPath) return null;
    const archived = await loadSession(archivedPath);
    return archived?.surfaceId === surfaceId
      ? rebaseArchivedSession(archived, archivedPath)
      : null;
  }

  async function saveSession(session: OwnedAcpSessionRecord): Promise<void> {
    session.updatedAt = nowIso();
    await writeJsonFile(metadataPath(session.sessionDir), session, { mode: 0o600 });
  }

  function replaceRun(session: OwnedAcpSessionRecord, run: OwnedAcpRunRecord): void {
    session.recentRuns = session.recentRuns.map((candidate) => candidate.id === run.id ? run : candidate);
    if (session.activeRun?.id === run.id) session.activeRun = run;
  }

  async function refreshSession(session: OwnedAcpSessionRecord): Promise<void> {
    const run = session.activeRun;
    if (!run || activeProcesses.get(session.surfaceId)?.client.alive) return;
    const pid = run.pid ?? session.rpcPid;
    if (pid && isPidAlive(pid)) return;
    if (run.outcome === 'running') {
      run.outcome = 'failed';
      run.finishedAt = run.finishedAt ?? nowIso();
      replaceRun(session, run);
      session.latestSummary = `${adapter.humanLabel} ACP process exited before the active turn settled.`;
    }
    session.activeRun = undefined;
    session.rpcPid = undefined;
    await saveSession(session);
  }

  async function listSessions(): Promise<OwnedAcpSessionRecord[]> {
    const sessions = (await Promise.all((await listDirs()).map(loadSession)))
      .filter((session): session is OwnedAcpSessionRecord => Boolean(session && !session.detachedAt));
    await Promise.all(sessions.map(refreshSession));
    return sessions;
  }

  async function handleNotification(
    surfaceId: string,
    notification: AcpRawNotification,
  ): Promise<void> {
    if (adapter.shouldPersistNotification?.(notification) === false) return;
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      const run = session?.activeRun;
      if (!session || !run) return;
      await appendFile(run.stdoutPath, `${JSON.stringify({
        jsonrpc: '2.0',
        method: notification.method,
        params: notification.params,
      })}\n`, 'utf8');
      const summary = adapter.notificationSummary?.(notification);
      if (summary) session.latestSummary = compactText(summary, 2_000);
      replaceRun(session, run);
      await saveSession(session);
    });
  }

  async function settlePrompt(
    surfaceId: string,
    runId: string,
    stopReason: AcpStopReason | null,
    error?: unknown,
  ): Promise<void> {
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      const run = session?.recentRuns.find((candidate) => candidate.id === runId);
      if (!session || !run || run.outcome !== 'running') return;
      const finishReason = stopReason ?? 'error';
      run.finishReason = finishReason;
      run.finishedAt = nowIso();
      run.outcome = error
        ? 'failed'
        : finishReason === 'cancelled'
          ? 'interrupted'
          : 'finished';
      await appendFile(run.stdoutPath, `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'o8/session.prompt.settled',
        params: { outcome: run.outcome, stopReason: finishReason },
      })}\n`, 'utf8');
      const parsed = adapter.parseRunLog(
        await readFile(run.stdoutPath, 'utf8').catch(() => ''),
        run,
      );
      session.latestSummary = error
        ? compactText(error instanceof Error ? error.message : String(error), 2_000)
        : parsed.entries.filter((entry) => entry.kind === 'message').at(-1)?.text
          ?? `${adapter.squadShortName} turn ${run.outcome}.`;
      replaceRun(session, run);
      session.activeRun = activeProcesses.get(surfaceId)?.client.alive ? run : undefined;
      await saveSession(session);
    });
  }

  async function recordProcessExit(
    surfaceId: string,
    process: ActiveAcpProcess,
  ): Promise<void> {
    if (activeProcesses.get(surfaceId)?.client !== process.client) return;
    activeProcesses.delete(surfaceId);
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      if (!session) return;
      session.rpcPid = undefined;
      const run = session.activeRun;
      if (run?.outcome === 'running') {
        run.outcome = 'failed';
        run.finishedAt = nowIso();
        replaceRun(session, run);
        session.latestSummary = `${adapter.humanLabel} ACP process exited before the active turn settled.`;
      }
      session.activeRun = undefined;
      await saveSession(session);
    });
  }

  async function retireUnattachedProcess(session: OwnedAcpSessionRecord): Promise<void> {
    const pid = session.rpcPid ?? session.activeRun?.pid;
    if (!pid || !isPidAlive(pid)) return;
    const commandLine = await pidCommandLine(pid);
    const expected = session.commandIdentity ?? adapter.binaryName;
    if (!commandLine?.includes(expected)) {
      throw new Error(`Persisted ACP pid ${pid} no longer matches ${expected}; no signal was sent.`);
    }
    const result = await escalateInterrupt({ pid, commandLabel: expected });
    if (!result.confirmedDead && !result.alreadyDead) throw new Error(result.note);
    await withSession(session.surfaceId, async () => {
      const current = await findSession(session.surfaceId, false);
      if (!current) return;
      const run = current.activeRun;
      if (run?.outcome === 'running') {
        run.outcome = 'failed';
        run.finishedAt = nowIso();
        replaceRun(current, run);
        current.activeRun = undefined;
      }
      current.rpcPid = undefined;
      await saveSession(current);
    });
  }

  async function ensureProcess(session: OwnedAcpSessionRecord): Promise<ActiveAcpProcess> {
    const existing = activeProcesses.get(session.surfaceId);
    if (existing?.client.alive && existing.credentialPolicy === credentialPolicyFingerprint(adapter.runtimeId)
      && existing.memoryRevision === session.promptMemoryRevision) { assertWorkerMemoryCurrent(session); return existing; }
    if (existing?.client.alive) { existing.client.kill(); activeProcesses.delete(session.surfaceId); }
    await retireUnattachedProcess(session);
    const launch = await adapter.resolveLaunch(session);
    const activeProcess: ActiveAcpProcess = {
      memoryRevision: session.promptMemoryRevision,
      credentialPolicy: credentialPolicyFingerprint(adapter.runtimeId),
      client: new AcpClient({
        command: launch.command,
        args: launch.args,
        cwd: session.repoPath,
        env: launch.env,
        runtimeId: adapter.runtimeId,
        requestTimeoutMs: 30_000,
        onNotification: (notification) => {
          // Resume can replay prior turns before the session response arrives.
          // Capture readiness before queueing persistence for the new run.
          if (!activeProcess.sessionId) return;
          void handleNotification(session.surfaceId, notification).catch((error) => {
            console.error(`[${adapter.runtimeId}] ACP notification persistence failed`, error);
          });
        },
        onRequest: adapter.handleRequest,
        onStderr: (chunk) => {
          void withSession(session.surfaceId, async () => {
            const current = await findSession(session.surfaceId, false);
            if (current?.activeRun) await appendFile(current.activeRun.stderrPath, chunk);
          });
        },
        onExit: () => {
          void recordProcessExit(session.surfaceId, activeProcess);
        },
      }),
      sessionId: '',
    };
    const { client } = activeProcess;
    activeProcesses.set(session.surfaceId, activeProcess);
    try {
      const initialized = await client.initialize();
      const validated = adapter.validateInitialize?.(initialized);
      const supportsResume = adapter.supportsResume?.(initialized)
        ?? sessionCapability(initialized, 'resume');
      assertWorkerMemoryCurrent(session);
      const priorSessionId = session.remoteSessionId ?? session.threadId;
      const resumed = Boolean(priorSessionId && supportsResume);
      if (priorSessionId && !supportsResume) {
        throw new Error(`${adapter.humanLabel} ACP process cannot reconnect to its persisted session.`);
      }
      const established = priorSessionId
        ? await client.resumeSession(priorSessionId, session.repoPath)
        : await client.newSession(session.repoPath);
      activeProcess.sessionId = established.sessionId;
      await adapter.configureSession?.({
        client,
        sessionId: established.sessionId,
        model: session.model,
        resumed,
      });
      await withSession(session.surfaceId, async () => {
        const current = await findSession(session.surfaceId, false);
        if (!current) return;
        current.remoteSessionId = established.sessionId;
        current.threadId = established.sessionId;
        current.rpcPid = client.pid;
        current.commandIdentity = launch.commandIdentity ?? path.basename(launch.command);
        current.serverVersion = validated?.version ?? initialized.agentInfo?.version ?? launch.version;
        current.supportsResume = supportsResume;
        if (current.activeRun) {
          current.activeRun.pid = client.pid;
          current.activeRun.commandIdentity = current.commandIdentity;
          replaceRun(current, current.activeRun);
        }
        await saveSession(current);
      });
      if (activeProcess.credentialPolicy !== credentialPolicyFingerprint(adapter.runtimeId)) throw new Error('Credentials or billing changed during ACP initialization. Retry the launch.');
      return activeProcess;
    } catch (error) {
      activeProcesses.delete(session.surfaceId);
      await client.close().catch(() => {});
      throw error;
    }
  }

  async function createRun(
    surfaceId: string,
    prompt: string,
    mode: 'launch' | 'resume',
  ): Promise<OwnedAcpRunRecord> {
    return withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      if (!session) throw new Error(`${adapter.humanLabel} session was not found.`);
      if (session.detachedAt) {
        throw new Error(`${adapter.humanLabel} session was detached from its closed packet and cannot be resumed.`);
      }
      if (session.activeRun?.outcome === 'running') {
        throw new Error(`${adapter.humanLabel} session still has an active turn.`);
      }
      await ensureDir(path.join(session.sessionDir, RUNS_DIR));
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const run: OwnedAcpRunRecord = {
        id,
        mode,
        prompt,
        memoryRevision: session.promptMemoryRevision,
        startedAt: nowIso(),
        outcome: 'running',
        stdoutPath: path.join(session.sessionDir, RUNS_DIR, `${id}.jsonl`),
        stderrPath: path.join(session.sessionDir, RUNS_DIR, `${id}.stderr.log`),
        pid: session.rpcPid,
        commandIdentity: session.commandIdentity,
      };
      session.latestPrompt = prompt;
      session.latestSummary = compactText(prompt, 140);
      session.reviewDisposition = 'watching';
      session.reviewDispositionUpdatedAt = nowIso();
      session.activeRun = run;
      session.recentRuns = [run, ...session.recentRuns].slice(0, 32);
      await saveSession(session);
      return run;
    });
  }

  async function dispatchPrompt(
    surfaceId: string,
    prompt: string,
    mode: 'launch' | 'resume',
  ): Promise<{ ok: boolean; note: string; sideEffect?: 'none' | 'unknown' }> {
    try {
      const prior = await findSession(surfaceId, false);
      if (!prior) throw new Error(`${adapter.humanLabel} session was not found.`);
      if (workerMemoryNeedsRefresh(prior)) {
        if (prior.activeRun?.outcome === 'running') throw new Error('Wait for the active ACP turn before rebuilding forgotten context.');
        // Kill/retire the old process before clearing its durable provider thread.
        await interrupt(surfaceId);
        await withSession(surfaceId, async () => {
          const current = await findSession(surfaceId, false);
          if (!current) throw new Error('The ACP worker disappeared before memory rebuild.');
          ({ prompt, mode } = await refreshOwnedWorkerMemory(current, prompt, mode, mode === 'resume'));
          current.remoteSessionId = undefined;
          await saveSession(current);
        });
      } else {
        await withSession(surfaceId, async () => {
          const current = await findSession(surfaceId, false);
          if (!current) throw new Error('The ACP worker disappeared before dispatch.');
          ({ prompt, mode } = await refreshOwnedWorkerMemory(current, prompt, mode, mode === 'resume'));
          if (mode === 'launch') {
            const old = activeProcesses.get(surfaceId);
            activeProcesses.delete(surfaceId);
            await old?.client.close();
            current.remoteSessionId = undefined;
          }
          await saveSession(current);
        });
      }
    } catch (error) {
      return { ok: false, sideEffect: 'none', note: error instanceof Error ? error.message : String(error) };
    }
    const run = await createRun(surfaceId, prompt, mode);
    let process: ActiveAcpProcess;
    try {
      const session = await findSession(surfaceId, false);
      if (!session) throw new Error(`${adapter.humanLabel} session was not found.`);
      process = await ensureProcess(session);
      assertWorkerMemoryCurrent(session);
      if (process.credentialPolicy !== credentialPolicyFingerprint(adapter.runtimeId)) {
        process.client.kill();
        throw new Error('Credentials or billing changed during ACP initialization. Retry the launch.');
      }
    } catch (error) {
      await settlePrompt(surfaceId, run.id, null, error);
      return {
        ok: false,
        sideEffect: 'none',
        note: error instanceof Error ? error.message : String(error),
      };
    }
    void process.client.prompt(
      process.sessionId,
      prompt,
      adapter.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    ).then(
      (stopReason) => settlePrompt(surfaceId, run.id, stopReason),
      (error) => settlePrompt(surfaceId, run.id, null, error),
    ).catch((error) => {
      console.error(`[${adapter.runtimeId}] ACP prompt settlement persistence failed`, error);
    });
    return {
      ok: true,
      note: mode === 'launch'
        ? `${adapter.humanLabel} accepted the first turn over ACP.`
        : `${adapter.humanLabel} accepted the follow-up over ACP.`,
    };
  }

  async function launch(request: {
    cwd: string;
    prompt: string;
    promptMemoryRevision?: string;
    clientMutationId?: string;
    laneId?: string;
    packetId?: string;
    model?: string;
    effort?: import('@/lib/orchestrator/thinking-effort').ThinkingEffort;
  }) {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('prompt is required');
    const repoPath = await validateWorkspace(request.cwd);
    const repo = await resolveRepoContext(repoPath);
    const id = `${adapter.sessionIdPrefix}${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sessionDir = path.join(root(), id);
    await mkdir(sessionDir, { recursive: true });
    const session: OwnedAcpSessionRecord = {
      surfaceId: `${adapter.surfaceIdPrefix}${id}`,
      launchMutationId: request.clientMutationId?.trim() || undefined,
      laneId: request.laneId?.trim() || undefined,
      packetId: request.packetId?.trim() || undefined,
      sessionDir,
      cwd: repoPath,
      repoPath,
      repoSlug: repo.repoSlug,
      branch: repo.branch,
      head: repo.head,
      title: repo.title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      latestPrompt: prompt,
      promptMemoryRevision: request.promptMemoryRevision,
      latestSummary: compactText(prompt, 140),
      model: request.model?.trim() || adapter.defaultModel,
      effort: request.effort,
      reviewDisposition: 'watching',
      reviewDispositionUpdatedAt: nowIso(),
      recentRuns: [],
    };
    await saveSession(session);
    const result = await dispatchPrompt(session.surfaceId, prompt, 'launch');
    return {
      ok: result.ok,
      runtime: adapter.runtimeId,
      surfaceId: session.surfaceId,
      note: result.note,
      sideEffect: result.sideEffect,
    };
  }

  async function resume(surfaceId: string, message: string) {
    const prompt = message.trim();
    if (!prompt) return { ok: false, note: 'message is required' };
    return dispatchPrompt(surfaceId, prompt, 'resume');
  }

  async function interrupt(surfaceId: string) {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error(`${adapter.humanLabel} session was not found.`);
    const active = activeProcesses.get(surfaceId);
    if (active) {
      if (session.activeRun?.outcome === 'running') active.client.cancel(active.sessionId);
      await withSession(surfaceId, async () => {
        const current = await findSession(surfaceId, false);
        if (!current) return;
        const run = current.activeRun;
        if (run?.outcome === 'running') {
          run.outcome = 'interrupted';
          run.finishedAt = nowIso();
          run.interruptRequestedAt = run.finishedAt;
          replaceRun(current, run);
        }
        current.activeRun = undefined;
        current.rpcPid = undefined;
        await saveSession(current);
      });
      activeProcesses.delete(surfaceId);
      await active.client.close();
    } else {
      await retireUnattachedProcess(session);
    }
    await withSession(surfaceId, async () => {
      const current = await findSession(surfaceId, false);
      if (!current) return;
      current.rpcPid = undefined;
      await saveSession(current);
    });
    return {
      interrupted: true,
      note: session.supportsResume
        ? `${adapter.humanLabel} ACP process stopped; the durable session can reconnect on the next turn.`
        : `${adapter.humanLabel} ACP process stopped.`,
    };
  }

  async function archiveSession(surfaceId: string) {
    const session = await findSession(surfaceId, false);
    if (!session) {
      const archived = await archivedSessionPathForSurfaceId(root(), surfaceId, adapter.surfaceIdPrefix);
      return archived
        ? { archived: true, archivePath: archived, note: 'Session already archived.' }
        : { archived: false, note: `${adapter.humanLabel} session was not found.` };
    }
    const stopped = await interrupt(surfaceId);
    if (!stopped.interrupted) return { archived: false, note: stopped.note };
    const latest = await findSession(surfaceId, false);
    if (!latest) return { archived: false, note: 'Session disappeared before archive.' };
    return archiveOwnedSessionDir(root(), latest as unknown as OwnedSessionRecord);
  }

  async function sweepOrphanedSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
    let archived = 0;
    for (const session of await listSessions()) {
      if (activeSurfaceIds.has(session.surfaceId)) continue;
      if (Date.now() - Date.parse(session.updatedAt) < maxAgeMs) continue;
      const result = await archiveSession(session.surfaceId).catch(() => null);
      if (result?.archived) archived += 1;
    }
    return archived;
  }

  function setDetachedSession(surfaceId: string, reason: string | null) {
    return withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      if (!session) {
        return {
          updated: false,
          previouslyDetached: false,
          note: `${adapter.humanLabel} session was not found.`,
        };
      }
      const previouslyDetached = Boolean(session.detachedAt);
      if (reason === null) {
        delete session.detachedAt;
        delete session.detachedReason;
      } else {
        session.detachedAt = session.detachedAt ?? nowIso();
        session.detachedReason = reason;
      }
      await saveSession(session);
      return {
        updated: true,
        previouslyDetached,
        note: reason === null
          ? `${adapter.humanLabel} session was restored to active discovery.`
          : `${adapter.humanLabel} recovery metadata was preserved outside active fleet discovery.`,
      };
    });
  }

  const presentation = createOwnedAcpPresentation({
    adapter,
    findSession,
    listSessions,
    saveSession,
    processAlive: (surfaceId) => activeProcesses.get(surfaceId)?.client.alive === true,
  });

  const store: OwnedAcpSessionStore = {
    runtimeId: adapter.runtimeId,
    surfaceIdPrefix: adapter.surfaceIdPrefix,
    launch,
    resume,
    interrupt,
    ...presentation,
    sessionState: (surfaceId) => readOwnedSessionState(root(), surfaceId, adapter.surfaceIdPrefix),
    archiveSession,
    setDetachedSession,
    sweepOrphanedSessions,
    getSessionIdentityId: async () => null,
    invalidateFleetCache: () => {},
  };

  registerOwnedSessionLifecycleHandler({
    runtimeId: adapter.runtimeId,
    surfaceIdPrefix: adapter.surfaceIdPrefix,
    commandLabel: adapter.binaryName,
    resolveRoot: root,
    sessionState: store.sessionState,
    archiveSession: store.archiveSession,
    setDetachedSession: store.setDetachedSession,
  });

  return store;
}
