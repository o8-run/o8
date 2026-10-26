import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { spawn } from '@/lib/providers/child-process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { codexServiceTierOptions, isOrchestratorServiceTier, type OrchestratorServiceTier, type ServiceTierOption } from '@/lib/orchestrator/service-tier';

export interface CodexSpeedCatalogue {
  models: Record<string, ServiceTierOption[]>;
  /** Complete model/list effort choices; null means the capability was not reported. */
  reasoningEfforts?: Record<string, string[] | null>;
  configuredTier?: OrchestratorServiceTier;
  defaultModel?: string;
}
let cache: { key: string; at: number; promise: Promise<CodexSpeedCatalogue> } | null = null;

/** Read-only model/list and config/read; never creates a thread or a provider turn. */
export async function getCodexSpeedCatalogue(home = path.join(homedir(), '.codex'), fresh = false): Promise<CodexSpeedCatalogue> {
  const binary = await resolveCli({ runtimeId: 'codex', binaryName: 'codex', envOverride: 'O8_CODEX_BIN' });
  // Match prepareCodexHome's source account; validation passes the prepared home.
  const authStat = await stat(path.join(home, 'auth.json')).catch(() => null);
  const configStat = await stat(path.join(home, 'config.toml')).catch(() => null);
  const key = `${binary.path}:${binary.version}:${home}:${authStat?.mtimeMs}:${configStat?.mtimeMs}:${credentialPolicyFingerprint('codex')}`;
  if (!fresh && cache?.key === key && Date.now() - cache.at < 5 * 60_000) return cache.promise;
  const promise = readCodexSpeedCatalogue(binary.path, childEnvironment({ runtimeId: 'codex', env: { CODEX_HOME: home, PATH: pathWithNodeRuntime() } }));
  cache = { key, at: Date.now(), promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}

export function readCodexSpeedCatalogue(binary: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<CodexSpeedCatalogue> {
  return new Promise((resolve, reject) => {
    const launch = cliInvocation(binary, ['app-server', '--stdio']);
    const child = spawn(launch.command, launch.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false; let buffer = ''; let catalogue: CodexSpeedCatalogue | null = null; let configDone = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 500); forceKill.unref(); child.once('exit', () => clearTimeout(forceKill));
      if (error || !catalogue) reject(error ?? new Error('Codex speed catalogue is unavailable.'));
      else resolve(catalogue);
    };
    const timer = setTimeout(() => finish(new Error('Codex speed catalogue timed out.')), timeoutMs);
    child.once('error', () => finish(new Error('Codex speed catalogue is unavailable.')));
    child.once('exit', () => finish()); child.stdin.on('error', () => finish());
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return; buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { finish(new Error('Codex speed catalogue exceeded its limit.')); return; }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const line of lines) {
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        if (!reply || typeof reply !== 'object') continue;
        if (reply.id === 1) {
          if (reply.error) { finish(new Error('Codex speed catalogue initialization failed.')); return; }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          send(2, 'model/list', { includeHidden: false }); send(3, 'config/read', { includeLayers: false });
        } else if (reply.id === 2) {
          if (reply.error || !Array.isArray(reply.result?.data)) { finish(new Error('Codex did not return a model catalogue.')); return; }
          const models = reply.result.data as Array<{ model?: unknown; serviceTiers?: unknown; additionalSpeedTiers?: unknown; supportedReasoningEfforts?: unknown; isDefault?: unknown }>;
          catalogue = {
            defaultModel: models.find(model => model.isDefault === true && typeof model.model === 'string')?.model as string | undefined,
            models: Object.fromEntries(models.flatMap(model => typeof model.model === 'string' ? [[model.model, codexServiceTierOptions(model)]] : [])),
            reasoningEfforts: Object.fromEntries(models.flatMap(model => typeof model.model === 'string' ? [[model.model,
              Array.isArray(model.supportedReasoningEfforts)
                ? model.supportedReasoningEfforts.flatMap(option => option && typeof option.reasoningEffort === 'string' ? [option.reasoningEffort] : [])
                : null,
            ]] : [])),
          };
        } else if (reply.id === 3) {
          configDone = true;
          const tier = reply.result?.config?.service_tier;
          const model = reply.result?.config?.model;
          if (typeof model === 'string' && model.trim()) configuredModel = model;
          if (isOrchestratorServiceTier(tier)) {
            // config/read may arrive before model/list.
            configuredTier = tier;
          }
        }
        if (catalogue && configDone) { if (configuredModel) catalogue.defaultModel = configuredModel; if (configuredTier) catalogue.configuredTier = configuredTier; finish(); return; }
      }
    });
    let configuredTier: OrchestratorServiceTier | undefined;
    let configuredModel: string | undefined;
    send(1, 'initialize', { clientInfo: { name: 'o8-speed-catalogue', version: '1' }, capabilities: { experimentalApi: true } });
  });
}
