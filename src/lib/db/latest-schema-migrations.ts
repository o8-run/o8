import { ensureV74ConversationPrProvenanceSchema } from '@/lib/db/v74-conversation-pr-provenance-migration';
import type Database from 'better-sqlite3';
import { ensureV36HarnessSchema } from '@/lib/db/v36-harness-migration';
import { ensureV37WorkspaceSnapshotSchema } from '@/lib/db/v37-workspace-snapshot-migration';
import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import { ensureV39WorkspaceLifecycleLeaseSchema } from '@/lib/db/v39-workspace-lifecycle-lease-migration';
import { ensureV40StorageRootIdentitySchema } from '@/lib/db/v40-storage-root-identity-migration';
import { ensureV41WorkspaceRetirementSchema } from '@/lib/db/v41-workspace-retirement-migration';
import { ensureV42WorkspaceRestoreClaimSchema } from '@/lib/db/v42-workspace-restore-claim-migration';
import { ensureV43ResourceLeaseSchema } from '@/lib/db/v43-resource-leases-migration';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';
import { ensureV46ReviewAttemptHeadSchema } from '@/lib/db/v46-review-attempt-head-migration';
import { ensureV47ExplainerQueueSchema } from '@/lib/db/v47-explainer-queue-migration';
import { ensureV48CloudJobSchema } from '@/lib/db/v48-cloud-job-migration';
import { ensureV49CloudJobControlSchema } from '@/lib/db/v49-cloud-job-control-migration';
import { ensureV50AutomationFireSchema } from '@/lib/db/v50-automation-fire-migration';
import { ensureV51AutomationPrecheckSchema } from '@/lib/db/v51-automation-precheck-migration';
import { ensureV52AutomationWatchSchema } from '@/lib/db/v52-automation-watch-migration';
import { ensureV53PromptLibrarySchema } from '@/lib/db/v53-prompt-library-migration';
import { ensureV54WorkerMcpInjectionSchema } from '@/lib/db/v54-worker-mcp-injection-migration';
import { ensureV55OutsiderAttentionSchema } from '@/lib/db/v55-outsider-attention-migration';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ensureV57CostLedgerAttributionSchema } from '@/lib/db/v57-cost-ledger-attribution-migration';
import { ensureV58SpectatorRepoGrantsSchema } from '@/lib/db/v58-spectator-repo-grants-migration';
import { ensureV59TaskArtifactsSchema } from '@/lib/db/v59-task-artifacts-migration';
import { ensureV60SymonMcpInjectionSchema } from '@/lib/db/v60-symon-mcp-injection-migration';
import { ensureV61PrMergeEvidenceSchema } from '@/lib/db/v61-pr-merge-evidence-migration';
import { ensureV62SymonWatchSchema } from '@/lib/db/v62-symon-watch-migration';
import { ensureV63JudgmentReceiptsSchema } from '@/lib/db/v63-judgment-receipts-migration';
import { ensureV64SymonFuzzyWatchSchema } from '@/lib/db/v64-symon-fuzzy-watch-migration';
import { ensureV65OrchestratorLeadSchema } from '@/lib/db/v65-orchestrator-lead-migration';
import { ensureV66CloudWorkerPresenceSchema } from '@/lib/db/v66-cloud-worker-presence-migration';
import { ensureV67WorkspacePreservationSchema } from '@/lib/db/v67-workspace-preservation-migration';
import { ensureV68TranscriptVisualizationsSchema } from '@/lib/db/v68-transcript-visualizations-migration';
import { ensureV69VisualizationVersionsSchema } from '@/lib/db/v69-visualization-versions-migration';
import { ensureV68ExactFinalizationSchema } from '@/lib/db/v68-exact-finalization-migration';
import { ensureV69GeneratedOutputSchema } from '@/lib/db/v69-generated-output-migration';
import { ensureV70WorkerReturnSchema } from '@/lib/db/v70-worker-return-migration';
import { ensureV71ComposerQueueSchema } from '@/lib/db/v71-composer-queue-migration';
import { ensureV72WorkerCorrectionsSchema } from '@/lib/db/v72-worker-corrections-migration';
import { ensureV73ConversationPrContextSchema } from '@/lib/db/v73-conversation-pr-context-migration';

/**
 * Keep the current additive migrations behind one boot hook. `db/index.ts` is
 * at its governed file ceiling, while these helpers must still run on every
 * connection so concurrent app processes can upgrade safely.
 */
export function ensureLatestSchemas(sqlite: Database.Database): void {
  ensureV36HarnessSchema(sqlite);
  ensureV37WorkspaceSnapshotSchema(sqlite);
  ensureV38StorageAdmissionSchema(sqlite);
  ensureV39WorkspaceLifecycleLeaseSchema(sqlite);
  ensureV40StorageRootIdentitySchema(sqlite);
  ensureV41WorkspaceRetirementSchema(sqlite);
  ensureV42WorkspaceRestoreClaimSchema(sqlite);
  ensureV43ResourceLeaseSchema(sqlite);
  ensureV44BroadcastSchema(sqlite);
  ensureV45BroadcastFocusSchema(sqlite);
  ensureV46ReviewAttemptHeadSchema(sqlite);
  ensureV47ExplainerQueueSchema(sqlite);
  ensureV48CloudJobSchema(sqlite);
  ensureV49CloudJobControlSchema(sqlite);
}

export function ensurePostAutomationSchemas(sqlite: Database.Database): void {
  ensureV50AutomationFireSchema(sqlite);
  ensureV51AutomationPrecheckSchema(sqlite);
  ensureV52AutomationWatchSchema(sqlite);
  ensureV53PromptLibrarySchema(sqlite);
  ensureV54WorkerMcpInjectionSchema(sqlite);
  ensureV55OutsiderAttentionSchema(sqlite);
  ensureV56ManagedSymonMessagesSchema(sqlite);
  ensureV57CostLedgerAttributionSchema(sqlite);
  ensureV58SpectatorRepoGrantsSchema(sqlite);
  ensureV59TaskArtifactsSchema(sqlite);
  ensureV60SymonMcpInjectionSchema(sqlite);
  ensureV61PrMergeEvidenceSchema(sqlite);
  ensureV62SymonWatchSchema(sqlite);
  ensureV63JudgmentReceiptsSchema(sqlite);
  ensureV64SymonFuzzyWatchSchema(sqlite);
  ensureV65OrchestratorLeadSchema(sqlite);
  ensureV66CloudWorkerPresenceSchema(sqlite);
  ensureV67WorkspacePreservationSchema(sqlite);
  ensureV68TranscriptVisualizationsSchema(sqlite);
  ensureV69VisualizationVersionsSchema(sqlite);
  ensureV68ExactFinalizationSchema(sqlite);
  ensureV69GeneratedOutputSchema(sqlite);
  ensureV70WorkerReturnSchema(sqlite);
  ensureV71ComposerQueueSchema(sqlite);
  ensureV72WorkerCorrectionsSchema(sqlite);
  ensureV73ConversationPrContextSchema(sqlite);
  ensureV74ConversationPrProvenanceSchema(sqlite);
}
