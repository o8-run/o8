// The handler, not the route: the route forwards to the WS listener when the native
// transport is on, and in the WS process that is a credential-less call to itself.
import { GET as getDefaults, POST as saveDefaults } from '@/app/api/panel/operator-defaults/handler';
import { GET as getConfig } from '@/app/api/setup/config/route';
import { POST as registerRepo } from '@/app/api/panel/repos/route';
import { validateRepo } from '@/lib/repos/registry';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { isAbsolute } from 'node:path';
import { isOrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import { isDispatchRuntime } from '@/lib/operator/defaults-env';
import { runtimeForLead, type RuntimeSetupRecommendation, type SetupRuntime } from './runtime-recommendation';
import { runtimeSelectionUpdate, type RuntimeSelection } from './runtime-selection';
import { queueAgentSetupRequest, readAgentSetupRequest, updateAgentSetupRequest, renewAgentSetupClaim } from './agent-request-store';
import type { SetupRequestStatus } from './agent-request';
import type { OperatorDefaultsWithSources } from '@/lib/operator/defaults';
import type { RuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';

type Defaults = OperatorDefaultsWithSources & {
  dispatchableRuntimes: SetupRuntime[];
  setupRecommendation: RuntimeSetupRecommendation;
  cliAuth: RuntimeAuthSnapshot;
};
async function json<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Setup operation failed.');
  return data as T;
}
const bodyRequest = (body: unknown) => new Request('http://localhost/api/setup/agent', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function defaults(): Promise<Defaults> {
  return json<Defaults>(await getDefaults(new Request('http://localhost/api/panel/operator-defaults?include=setup')));
}
const choiceKeys = ['orchestratorBackend', 'orchestratorModel', 'opencodeOrchestratorModel', 'defaultDispatchRuntime', 'defaultDispatchModel', 'opencodeWorkerModel', 'workerRuntimes'] as const;
export async function agentSetupStatus() {
  const [data, config] = await Promise.all([defaults(), json<{ setupComplete: boolean }>(await getConfig())]);
  const recommendation = data.setupRecommendation;
  const selectedLead = runtimeForLead(recommendation.backend);
  const available = (id: string) => data.dispatchableRuntimes.some((item) => item.id === id && item.available);
  const toolsReady = (selectedLead ? available(selectedLead) : recommendation.backend === 'o8' || Boolean(recommendation.backend && recommendation.preserved))
    && recommendation.workerRuntimes.length > 0 && recommendation.workerRuntimes.every(available);
  const request = readAgentSetupRequest();
  return {
    schema: 'o8/setup/v1',
    setupComplete: config.setupComplete,
    choices: Object.fromEntries(choiceKeys.map((key) => [key, { value: data.values[key], source: data.sources[key] }])),
    recommendation,
    runtimes: data.dispatchableRuntimes.map((item) => ({
      ...item,
      credentialEvidence: Object.values(data.cliAuth.statuses).find((auth) => auth.runtime === item.id)?.authenticated ?? null,
      providerAcceptance: 'not_checked',
    })),
    privacyAnswered: data.values.telemetryConsentAnswered,
    incompleteSteps: [
      ...(!config.setupComplete && !request ? ['project'] : []),
      ...(!toolsReady ? ['tools'] : []),
      ...(!data.values.telemetryConsentAnswered ? ['privacy'] : []),
      ...((request ? request.status !== 'opened' : !config.setupComplete) ? ['workspace'] : []),
    ],
    request,
    humanHandoffs: ['Sign in through the runtime when credentials are missing.', 'Grant operating-system permissions yourself.', 'Choose privacy settings in the app.'],
  };
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((key) => !['action', ...allowed].includes(key));
  if (extra.length) throw new Error(`Unsupported setup fields: ${extra.join(', ')}`);
}
export async function mutateAgentSetup(body: Record<string, unknown>) {
  return withPacketLifecycleMutationLock('system:agent-setup', () => mutate(body));
}
async function mutate(body: Record<string, unknown>) {
  if (body.action === 'configure') {
    fields(body, ['orchestratorRuntime', 'workerRuntimes', 'leadModel', 'workerModel']);
    const backend = body.orchestratorRuntime === 'claude-code' ? 'claude' : body.orchestratorRuntime;
    if (!isOrchestratorBackendSetting(backend) || backend === 'auto' || body.orchestratorRuntime === 'claude') throw new Error('Choose a supported orchestratorRuntime (use claude-code for Claude).');
    if (!Array.isArray(body.workerRuntimes) || !body.workerRuntimes.length || !body.workerRuntimes.every(isDispatchRuntime)) throw new Error('Choose at least one supported worker runtime.');
    for (const key of ['leadModel', 'workerModel']) if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`${key} must be a string.`);
    const current = await defaults();
    const selection = body as unknown as RuntimeSelection;
    const lead = runtimeForLead(backend);
    if ((!lead && backend !== 'o8' && current.values.orchestratorBackend !== backend)
      || [lead, ...selection.workerRuntimes].some((id) => id && !current.dispatchableRuntimes.some((runtime) => runtime.id === id && runtime.available))) {
      throw new Error('A selected runtime is unavailable. Read setup status for its sign-in or installation handoff.');
    }
    const update = runtimeSelectionUpdate(selection);
    for (const key of Object.keys(update) as (keyof typeof update)[]) {
      if (['env', 'profile'].includes(current.sources[key])) throw new Error(`${key} is controlled by ${current.sources[key]}; change that source first.`);
    }
    await json(await saveDefaults(bodyRequest(update)));
    const persisted = await agentSetupStatus();
    return { ...persisted, result: 'saved' };
  }
  if (body.action === 'open') {
    fields(body, ['path', 'requestId']);
    if (typeof body.path !== 'string' || !isAbsolute(body.path.trim())) throw new Error('path must be an absolute project folder path.');
    const path = (await validateRepo(body.path.trim())).localPath;
    const current = readAgentSetupRequest();
    if (body.requestId !== undefined) {
      if (typeof body.requestId !== 'string' || current?.id !== body.requestId || current.project.localPath !== path) throw new Error('Retry requestId and path must match the current receipt.');
      return { schema: 'o8/setup/v1', request: current, result: current.status };
    }
    if (current && ['pending', 'applying'].includes(current.status)) {
      if (current.project.localPath !== path) throw new Error('Another project opening is pending. Read its status or cancel it first.');
      return { schema: 'o8/setup/v1', request: current, result: current.status };
    }
    const { repo } = await json<{ repo: Parameters<typeof queueAgentSetupRequest>[0] }>(await registerRepo(bodyRequest({ action: 'add', localPath: path })));
    const request = queueAgentSetupRequest(repo);
    return { schema: 'o8/setup/v1', request, result: request.status, next: request.status === 'pending' ? 'Keep onboarding open in the app; read status for its receipt.' : 'Read status for the current result.' };
  }
  if (body.action === 'renew') {
    fields(body, ['requestId', 'claimId']);
    if (typeof body.requestId !== 'string' || typeof body.claimId !== 'string') throw new Error('An app claim is required.');
    return { request: renewAgentSetupClaim(body.requestId, body.claimId) };
  }
  if (body.action === 'cancel' || body.action === 'claim' || body.action === 'ack') {
    fields(body, body.action === 'ack' ? ['requestId', 'status', 'error', 'claimId'] : ['requestId']);
    if (typeof body.requestId !== 'string' || !body.requestId) throw new Error('requestId is required.');
    const status = body.action === 'cancel' ? 'cancelled' : body.action === 'claim' ? 'applying' : body.status;
    if (!['cancelled', 'applying', 'opened', 'needs_tools', 'needs_privacy', 'error'].includes(String(status))) throw new Error('Invalid setup result.');
    if (body.action === 'ack' && !['opened', 'needs_tools', 'needs_privacy', 'error'].includes(String(status))) throw new Error('Invalid app acknowledgement.');
    if (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 1000)) throw new Error('error must be a short message.');
    return { request: updateAgentSetupRequest(body.requestId, status as SetupRequestStatus, body.error as string | undefined, typeof body.claimId === 'string' ? body.claimId : undefined) };
  }
  throw new Error('Use configure, open, or cancel. Read status before changing setup.');
}
