import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';

export type ProductEventName =
  | 'app.opened'
  | 'brain.asked'
  | 'orchestrator.message'
  | 'dispatch.started'
  | 'merge.approved'
  | 'repo.added'
  | 'worker.first_launched'
  | 'merge.first_completed'
  | 'session.ended';

/** Exact first-run disclosure for the complete wire allowlist. Keep the field
 * wording aligned with docs/user/product-telemetry-privacy.md. */
export const PRODUCT_EVENT_DISCLOSURES = [
  { event: 'app.opened', fields: 'no properties' },
  { event: 'brain.asked', fields: 'no properties' },
  { event: 'orchestrator.message', fields: 'no properties' },
  { event: 'dispatch.started', fields: 'runtime — known worker-runtime enum' },
  { event: 'merge.approved', fields: 'runtime — known worker-runtime enum; pushed — boolean' },
  { event: 'repo.added', fields: 'hasRemote — boolean; isGitRepo — boolean' },
  { event: 'worker.first_launched', fields: 'no properties' },
  { event: 'merge.first_completed', fields: 'no properties' },
  { event: 'session.ended', fields: 'clean — boolean' },
] as const satisfies ReadonlyArray<{ event: ProductEventName; fields: string }>;

export type ProductEventProps = Partial<{
  runtime: OrchestratorRuntime;
  pushed: boolean;
  hasRemote: boolean;
  isGitRepo: boolean;
  clean: boolean;
}>;

export type ProductEventPayload =
  | { event: 'app.opened' | 'brain.asked' | 'orchestrator.message' | 'worker.first_launched' | 'merge.first_completed' }
  | { event: 'dispatch.started'; props: { runtime: OrchestratorRuntime } }
  | { event: 'merge.approved'; props: { runtime: OrchestratorRuntime; pushed: boolean } }
  | { event: 'repo.added'; props: { hasRemote: boolean; isGitRepo: boolean } }
  | { event: 'session.ended'; props: { clean: boolean } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedRuntime(value: unknown): value is OrchestratorRuntime {
  return isOrchestratorRuntime(value);
}

/**
 * The complete product-telemetry wire allowlist. Unknown events, missing fields,
 * and non-enum values fail closed; extra properties are discarded.
 */
export function sanitizeProductEvent(event: unknown, props?: unknown): ProductEventPayload | null {
  if (event === 'app.opened' || event === 'brain.asked' || event === 'orchestrator.message'
    || event === 'worker.first_launched' || event === 'merge.first_completed') return { event };
  if (!isRecord(props)) return null;

  if (event === 'session.ended' && typeof props.clean === 'boolean') {
    return { event, props: { clean: props.clean } };
  }
  if (event === 'dispatch.started' && isAllowedRuntime(props.runtime)) {
    return { event, props: { runtime: props.runtime } };
  }
  if (event === 'merge.approved' && isAllowedRuntime(props.runtime) && typeof props.pushed === 'boolean') {
    return { event, props: { runtime: props.runtime, pushed: props.pushed } };
  }
  if (event === 'repo.added' && typeof props.hasRemote === 'boolean' && typeof props.isGitRepo === 'boolean') {
    return { event, props: { hasRemote: props.hasRemote, isGitRepo: props.isGitRepo } };
  }
  return null;
}
