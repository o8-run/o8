import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { delegationInstance, withDelegationInstance } from '@/lib/orchestrator/delegation-instance';
import { bindThreadProviderInstance } from '@/lib/providers/instances';
import type { RuntimeLaunchRequest } from './launch-request';

/** A packet's saved pin also applies to relaunches that omit the original argument. */
export async function withLaunchProviderInstance<T extends { surfaceId: string }>(
  payload: Pick<RuntimeLaunchRequest, 'runtime' | 'packetId' | 'instanceId'>,
  operation: () => Promise<T>,
): Promise<T> {
  const packetInstanceId = payload.packetId
    ? readOrchestratorControlPlaneState().packets.find(packet => packet.id === payload.packetId)?.instanceId
    : undefined;
  if (packetInstanceId && payload.instanceId && packetInstanceId !== payload.instanceId) {
    throw new Error('The launch does not match the packet provider instance.');
  }
  const instanceId = packetInstanceId ?? payload.instanceId;
  if (instanceId === undefined) return operation();
  const instance = delegationInstance({ instanceId, runtime: payload.runtime });
  return withDelegationInstance(instance, async () => {
    const result = await operation();
    if (result.surfaceId && instance) bindThreadProviderInstance(result.surfaceId, instance.id);
    return result;
  });
}
