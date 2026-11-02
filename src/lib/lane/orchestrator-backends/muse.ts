import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import { boundedMuseRequest, createMuseHost, type MuseHost } from '@/lib/muse/host';
import { createMuseEventMapper, museRecord, museTerminalEvent } from '@/lib/muse/protocol';
import { requestMuseApproval } from '@/lib/muse/approval';
import { createMuseApprovalStages } from '@/lib/muse/approval-stages';
import { captureMuseRuntimeConfig, museRoot } from '@/lib/muse/roots';
import { decodeMuseModels } from '@/lib/muse/models';
import { EffortPinRejectionError, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorBackend, OrchestratorTurnOptions } from './types';

interface MuseResident {
  host: MuseHost;
  sessionId: string;
  model: string | null;
  configRoot: string;
  dataRoot: string;
  readOnly: boolean;
  profile: NonNullable<OrchestratorTurnOptions['toolProfile']>;
  emit?: (event: OrchestratorEvent) => void;
  terminal?: (params: Record<string, unknown>) => void;
  turnId?: string;
  signal?: AbortSignal;
  idle?: ReturnType<typeof setTimeout>;
  approvals?: ReturnType<typeof createMuseApprovalStages>;
  closing?: Promise<void>;
  blocked?: boolean;
}

export function createMuseBackend(deps: {
  openHost?: typeof createMuseHost;
  stateRoot?: () => string;
  approve?: typeof requestMuseApproval;
  turnTimeoutMs?: number;
} = {}): OrchestratorBackend & { closeAll(): Promise<void> } {
  const residents = new Map<string, MuseResident>();
  const active = new Set<string>();
  const stateRoot = deps.stateRoot ?? (() => join(getDataDir(), 'muse', 'orchestrator'));
  const nameFor = (repo: string, thread?: string | null) => `muse:${createHash('sha256').update(`${repo}\0${thread ?? ''}`).digest('hex')}`;
  const fileFor = (name: string) => join(stateRoot(), `${name.slice(5)}.json`);
  async function admitEffort(host: MuseHost, model: string | null, effort: OrchestratorTurnOptions['thinkingEffort']) {
    if (!effort || effort === 'adaptive') return;
    const models = decodeMuseModels(await boundedMuseRequest(host.connection.request('model/list', {}), host));
    model = model?.trim() || models.find(row => row.isDefault)?.id || null;
    const pin = resolveEffortPin({ runtime: 'muse', model, requestedEffort: effort,
      modelEfforts: models.find(row => row.id === model)?.efforts });
    if (!pin.ok) throw new EffortPinRejectionError(pin.code, pin.message);
  }
  async function close(name: string) {
    const resident = residents.get(name);
    if (!resident) return;
    clearTimeout(resident.idle); resident.approvals?.clear();
    resident.closing ??= resident.host.close().then(() => { residents.delete(name); }, error => {
      resident.blocked = true;
      throw error;
    });
    await resident.closing;
  }
  async function save(name: string, resident: MuseResident, repoPath: string) {
    const file = fileFor(name);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ sessionId: resident.sessionId, model: resident.model, repoPath,
      configRoot: resident.configRoot, dataRoot: resident.dataRoot }), { mode: 0o600 });
    await rename(temp, file);
  }
  async function open(name: string, repoPath: string, options: OrchestratorTurnOptions): Promise<MuseResident> {
    const readOnly = options.permissionMode === 'plan' || options.toolProfile === 'propose';
    const profile = readOnly ? 'propose' : options.toolProfile ?? 'full';
    const existing = residents.get(name);
    if (existing?.blocked || existing?.closing) throw new Error('Muse shutdown is unresolved. The conversation remains held.');
    if (existing?.readOnly === readOnly && existing.profile === profile) {
      await admitEffort(existing.host, options.model ?? existing.model, options.thinkingEffort);
      clearTimeout(existing.idle); return existing;
    }
    if (existing) await close(name);
    const canonical = await realpath(repoPath);
    let metadataPresent = true;
    const stored: Record<string, unknown> = await readFile(fileFor(name), 'utf8').then(raw => museRecord(JSON.parse(raw))).catch((error: NodeJS.ErrnoException): Record<string, unknown> => {
      if (error.code === 'ENOENT') { metadataPresent = false; return {}; }
      throw new Error('Muse session metadata could not be read. Its conversation was preserved.');
    });
    if (metadataPresent && ['repoPath', 'sessionId', 'configRoot', 'dataRoot'].some(key => typeof stored[key] !== 'string' || !stored[key])) throw new Error('Muse session metadata is incomplete. Its conversation was preserved.');
    if (stored.repoPath && stored.repoPath !== canonical) throw new Error('Muse session belongs to a different workspace.');
    const roots = metadataPresent ? { museConfigRoot: stored.configRoot as string, museDataRoot: stored.dataRoot as string } : captureMuseRuntimeConfig();
    const configRoot = museRoot(roots.museConfigRoot, metadataPresent, canonical);
    const dataRoot = museRoot(roots.museDataRoot, metadataPresent, canonical);
    const host = await (deps.openHost ?? createMuseHost)({ cwd: canonical, readOnly, signal: options.signal, configRoot, dataRoot });
    try {
      await admitEffort(host, options.model ?? (typeof stored.model === 'string' ? stored.model : null), options.thinkingEffort);
      const registry = toOpenclawJson(buildToolRegistry(canonical, { profile, threadId: options.threadId }));
      const servers = Object.fromEntries(Object.entries(registry.servers).map(([key, value]) => [key, { ...museRecord(value), transport: 'stdio' }]));
      if (!host.initializeResult.grantedCapabilities.includes('sessionMcp')) throw new Error('Muse did not grant the required o8 tool connection.');
      const config = { mcpServers: servers };
      const opened = await boundedMuseRequest(typeof stored.sessionId === 'string'
        ? host.connection.command('session/resume', { sessionId: stored.sessionId, config })
        : host.connection.command('session/start', { workspaceRoot: canonical, providerId: 'meta', approvalMode: 'promptUnmatched', config, ...(options.model ? { modelId: options.model } : {}) }), host);
      const session = museRecord(opened.session);
      if (typeof session.sessionId !== 'string' || session.workspaceRoot !== canonical || session.providerId !== 'meta') throw new Error('Muse returned a session for an unexpected workspace or provider.');
      // Resume cannot select its initial mode. Reapply it before any new model turn.
      const policy = await boundedMuseRequest(host.connection.command('session/setApprovalMode', { sessionId: session.sessionId, mode: 'promptUnmatched' }), host);
      if (museRecord(policy.effectiveMode).mode !== 'promptUnmatched') throw new Error('Muse did not apply the required approval mode.');
      if (host.initializeResult.museHome !== join(dataRoot, 'muse')) throw new Error('Muse returned a different state directory.');
      const resident: MuseResident = { host, sessionId: session.sessionId, model: typeof session.modelId === 'string' ? session.modelId : null,
        configRoot, dataRoot, readOnly, profile };
      const map = createMuseEventMapper(resident.sessionId);
      host.connection.onServerRequest(async () => ({}));
      host.connection.onNotification(notification => {
        const params = museRecord(notification.params);
        if (params.sessionId !== resident.sessionId) return;
        for (const event of map(notification)) resident.emit?.(event);
        if (notification.method === 'turn/completed') {
          if (resident.turnId && params.turnId === resident.turnId) resident.terminal?.(params);
        }
        if (notification.method.startsWith('approval/')) resident.approvals?.accept(notification.method, params);
      });
      const transportFailed = () => {
        resident.terminal?.({ sessionId: resident.sessionId, terminal: 'failed' });
        void close(name).catch(() => {});
      };
      host.connection.onProtocolError(transportFailed);
      void host.connection.closed.then(transportFailed, transportFailed);
      await save(name, resident, canonical);
      residents.set(name, resident);
      return resident;
    } catch (error) {
      // A failed initialization still owns the host until teardown is proven.
      const held: MuseResident = { host, sessionId: '', model: null, configRoot, dataRoot, readOnly, profile, blocked: true };
      residents.set(name, held);
      await close(name);
      throw error;
    }
  }
  return {
    id: 'muse', label: 'Muse Code',
    ensureSession(repo, _agent, thread) { return { sessionName: nameFor(repo, thread), status: active.has(nameFor(repo, thread)) ? 'busy' : 'ready' }; },
    peekSession(repo, _agent, thread) { const name = nameFor(repo, thread); return residents.has(name) ? { sessionName: name, status: active.has(name) ? 'busy' : 'ready' } : null; },
    async sendTurn(repo, message, onEvent, options = {}) {
      const name = nameFor(repo, options.threadId);
      if (active.has(name)) { onEvent({ type: 'error', error: 'Muse is already working in this conversation.' }); return; }
      active.add(name);
      let resident: MuseResident | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let teardown: Promise<void> | undefined;
      let abort = () => {};
      try {
        options.signal?.throwIfAborted();
        resident = await open(name, repo, options);
        resident.emit = onEvent; resident.signal = options.signal;
        if (options.model && options.model !== resident.model) {
          await boundedMuseRequest(resident.host.connection.command('session/setModel', { sessionId: resident.sessionId, model: { modelId: options.model } }), resident.host);
          resident.model = options.model;
          await save(name, resident, await realpath(repo));
        }
        await admitEffort(resident.host, resident.model, options.thinkingEffort);
        options.signal?.throwIfAborted();
        const current = resident;
        current.approvals = createMuseApprovalStages({ approve: deps.approve ?? requestMuseApproval,
          context: { sessionKey: name, repoPath: repo, signal: options.signal },
          turnId: () => current.turnId,
          decide: params => boundedMuseRequest(current.host.connection.command('approval/decide', { sessionId: current.sessionId, ...params }), current.host),
          fail: () => {
            teardown ??= close(name);
            void teardown.then(() => current.terminal?.({ terminal: 'failed' }), () => current.terminal?.({ terminal: 'failed' }));
          } });
        const commandId = current.host.connection.mintCommandId();
        current.turnId = commandId;
        const terminal = new Promise<Record<string, unknown>>(resolve => { current.terminal = resolve; });
        abort = () => {
          void current.host.connection.command('turn/cancel', { sessionId: current.sessionId, ...(current.turnId ? { turnId: current.turnId } : {}) }).catch(() => {});
          teardown ??= close(name);
          void teardown.then(() => current.terminal?.({ terminal: 'cancelled', sessionId: current.sessionId }),
            () => current.terminal?.({ terminal: 'failed', sessionId: current.sessionId }));
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        watchdog = setTimeout(abort, deps.turnTimeoutMs ?? 30 * 60_000); watchdog.unref();
        onEvent({ type: 'turn_receipt', leadModel: current.model ?? 'Muse default', effort: options.thinkingEffort ?? 'adaptive',
          ...(!options.thinkingEffort || options.thinkingEffort === 'adaptive' ? { effortSource: 'runtime-default' as const } : {}) });
        const prompt = `${buildOrchestratorSystemPrompt(repo, { backend: 'muse', toolProfile: current.readOnly ? 'propose' : options.toolProfile ?? 'full' })}\n\n${message}`;
        const started = await boundedMuseRequest(current.host.connection.command('turn/start', { sessionId: current.sessionId,
          input: [{ type: 'text', text: prompt }], ifBusy: 'reject', ...(options.thinkingEffort && options.thinkingEffort !== 'adaptive' ? { reasoningEffort: options.thinkingEffort } : {}) }, { commandId }), current.host);
        if (started.turnId !== commandId || started.disposition !== 'started') throw new Error('Muse did not acknowledge this turn identity.');
        onEvent(museTerminalEvent(await terminal));
      } catch (error) {
        console.warn('[muse-orchestrator] turn failed:', error);
        onEvent({ type: 'error', error: options.signal?.aborted ? 'Muse turn cancelled.' : error instanceof EffortPinRejectionError
          ? error.message : 'Muse could not start or resume this turn. Check its connection and selected model. The conversation is retained.' });
        teardown ??= close(name);
      } finally {
        clearTimeout(watchdog); options.signal?.removeEventListener('abort', abort);
        let stopped = true;
        teardown ??= resident?.closing;
        if (teardown) { try { await teardown; } catch { stopped = false; } }
        if (residents.get(name)?.blocked) stopped = false;
        if (stopped) active.delete(name);
        if (resident) { resident.approvals?.clear(); resident.approvals = undefined; resident.emit = undefined; resident.terminal = undefined; resident.signal = undefined; resident.turnId = undefined;
          resident.idle = setTimeout(() => { void close(name).catch(() => {}); }, 10 * 60_000); resident.idle.unref(); }
      }
    },
    async closeAll() { await Promise.allSettled([...residents.keys()].map(close)); },
  };
}

export const museBackend = createMuseBackend();
