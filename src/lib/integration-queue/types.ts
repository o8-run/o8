import { z } from 'zod';
import type { EffectivePolicy } from '@/lib/lane/effective-policy';

const id = z.string().trim().min(1).max(200);
export const queueSpecSchema = z.object({
  targetRef: z.string().regex(/^refs\/(heads|remotes)\/[A-Za-z0-9/_().-]+$/).max(300),
  changes: z.array(z.object({ id, dependsOn: z.array(id).max(100).default([]) }).strict()).min(1).max(100),
  // Explicit operator invocation only. There is no default check or automatic drain.
  checks: z.array(z.object({
    name: id, command: z.string().min(1).max(1000), args: z.array(z.string().max(4000)).max(100),
    timeoutMs: z.number().int().min(1).max(300000),
  }).strict()).min(1).max(8),
}).strict().superRefine((spec, context) => {
  if (new Set(spec.changes.map(change => change.id)).size !== spec.changes.length
    || new Set(spec.checks.map(check => check.name)).size !== spec.checks.length) {
    context.addIssue({ code: 'custom', message: 'Change IDs and check names must be unique.' });
  }
});
export type QueueSpec = z.infer<typeof queueSpecSchema>;
export interface QueueEntry {
  id: string;
  packetId: string | null;
  laneId: string | null;
  headSha: string | null;
  comparisonSha: string | null;
  revisionId: string | null;
  declaredDependencies: string[];
  detectedDependencies: string[];
  satisfiedDependencies: Array<{ id: string; headSha: string; mergeCommit: string; source: string }>;
  overlapDependencies: string[];
  files: string[];
  blockers: string[];
  policy: EffectivePolicy | null;
}
export interface QueuePlan {
  repoId: string;
  targetRef: string;
  targetSha: string | null;
  entries: QueueEntry[];
  order: string[];
  blockers: string[];
  inputHash: string;
}
export const attemptSchema = z.object({
  id: z.string(), inputHash: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(),
  status: z.enum(['verifying', 'passed', 'failed', 'conflict', 'stale', 'blocked', 'interrupted']),
  execution: z.object({ status: z.string(), reason: z.string().nullable() }).nullable(),
  order: z.array(z.string()), targetSha: z.string().nullable(),
  evidence: z.object({ spec: queueSpecSchema, plan: z.unknown() }),
  sources: z.array(z.object({ id: z.string(), headSha: z.string().nullable() })),
  candidate: z.object({ headSha: z.string(), treeSha: z.string() }).nullable(),
  checks: z.array(z.object({ name: z.string(), verdict: z.enum(['pass', 'fail']), exitCode: z.number().nullable(), unconfined: z.boolean() })),
  reason: z.string().nullable(), publication: z.literal('not_requested'),
});
export type QueueAttempt = z.infer<typeof attemptSchema>;
export const queueRecordSchema = z.object({
  version: z.literal(1), repoId: z.string(), spec: queueSpecSchema, attempts: z.array(attemptSchema),
});
export type QueueRecord = z.infer<typeof queueRecordSchema>;
export class IntegrationQueueError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
