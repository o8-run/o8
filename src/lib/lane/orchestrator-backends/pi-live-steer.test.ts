import { afterEach, expect, it, vi } from 'vitest';
import { createPiOrchestratorBackend } from './pi';
import * as platform from '@/lib/pi/sdk/platform';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import { MANUAL_THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';

const sdk = vi.hoisted(() => ({ prompt: vi.fn(), steer: vi.fn(async () => ({ accepted: true })) }));
vi.mock('@/lib/pi/sdk/session', () => ({ createPiSdkSession: async () => ({
  sessionId: 'native-session', running: true, prompt: sdk.prompt, steer: sdk.steer, close: async () => {}, abort: async () => {},
}) }));
afterEach(() => vi.restoreAllMocks());

async function runningBackend() {
  let release!: () => void;
  sdk.steer.mockClear(); sdk.prompt.mockClear();
  sdk.prompt.mockImplementation(() => new Promise(resolve => { release = () => resolve({}); }));
  const resolveRoute = vi.fn(async (requested?: string | null) => ({ carrier: 'managed' as const,
    model: { ...O8_MANAGED_PI_MODEL, id: requested ?? O8_MANAGED_PI_MODEL.id }, label: 'Fixture model' }));
  const backend = createPiOrchestratorBackend({ stateRoot: () => '/fixture/steer-state', resolveRoute,
    openServers: async () => ({ servers: [], close: async () => {} }), transport: async function* () {} });
  const turn = backend.sendTurn('/fixture/repo', 'Start', () => {}, { threadId: 'thoughts-live', model: 'original', permissionMode: 'full' });
  await vi.waitFor(() => expect(sdk.prompt).toHaveBeenCalled());
  return { backend, resolveRoute, close: async () => { release(); await turn; await backend.closeAll(); } };
}

it('admits native steering immediately before the acknowledged SDK call', async () => {
  const fixture = await runningBackend();
  const beforeAdmit = vi.fn(() => { expect(sdk.steer).not.toHaveBeenCalled(); });
  try {
    expect(await fixture.backend.liveSteer!('/fixture/repo', 'Smaller change', { threadId: 'thoughts-live', model: 'original', permissionMode: 'full', beforeAdmit })).toEqual({ accepted: true });
    expect(beforeAdmit).toHaveBeenCalledOnce(); expect(sdk.steer).toHaveBeenCalledWith('Smaller change');
  } finally { await fixture.close(); }
});

it('refuses a changed model or permission surface without admitting into the previous resident', async () => {
  const fixture = await runningBackend(); const beforeAdmit = vi.fn();
  try {
    for (const options of [{ model: 'different', permissionMode: 'full' as const }, { model: 'original', permissionMode: 'plan' as const }]) {
      expect(await fixture.backend.liveSteer!('/fixture/repo', 'Smaller change', { ...options, threadId: 'thoughts-live', beforeAdmit })).toEqual({ accepted: false });
    }
    expect(beforeAdmit).not.toHaveBeenCalled(); expect(sdk.steer).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('refuses every concrete live pin before model lookup, admission or native input', async () => {
  const fixture = await runningBackend(); const beforeAdmit = vi.fn();
  fixture.resolveRoute.mockClear();
  try {
    for (const thinkingEffort of MANUAL_THINKING_EFFORTS) {
      await expect(fixture.backend.liveSteer!('/fixture/repo', 'Pinned follow-up', {
        threadId: 'thoughts-live', model: 'original', permissionMode: 'full', thinkingEffort, beforeAdmit,
      })).rejects.toThrow(`independent thinking effort "${thinkingEffort}"`);
    }
    expect(beforeAdmit).not.toHaveBeenCalled(); expect(sdk.steer).not.toHaveBeenCalled();
    expect(fixture.resolveRoute).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('rechecks cancellation after asynchronous model resolution and before native input', async () => {
  const fixture = await runningBackend();
  try {
    await expect(fixture.backend.liveSteer!('/fixture/repo', 'Smaller change', { threadId: 'thoughts-live', model: 'original', permissionMode: 'full',
      beforeAdmit: () => { throw new Error('Stopped during preparation'); } })).rejects.toThrow('Stopped during preparation');
    expect(sdk.steer).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it('does not advertise live steering on an unsupported platform', () => {
  vi.spyOn(platform, 'requirePiPlatform').mockImplementation(() => { throw new Error('Unsupported'); });
  expect(createPiOrchestratorBackend().liveSteer).toBeUndefined();
});
