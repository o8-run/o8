import { startCortexDiagnosticsPublisher } from '@/lib/cortex/diagnostics-state';
import { ensureCodebaseMemoryBootIndex } from '@/lib/codebase-memory/indexer';
import { ensureDecayBootHook } from '@/lib/cortex/decay';
import { ensureProposerBootTick } from '@/lib/cortex/proposer';
import { ensureStackSignatureBoot } from '@/lib/cortex/stack-signature';
import { ensureCrossRepoProposerBootTick } from '@/lib/cortex/cross-repo-proposer';
import { ensureExternalMergeBootHook } from '@/lib/cortex/external-merge-watcher';
import { ensureShippedDarkAuditBootHook } from '@/lib/operator/shipped-dark-scheduler';

export function startStatusBootHooks(): void {
  startCortexDiagnosticsPublisher();
  ensureCodebaseMemoryBootIndex();
  ensureDecayBootHook();
  ensureProposerBootTick();
  ensureStackSignatureBoot();
  ensureCrossRepoProposerBootTick();
  ensureExternalMergeBootHook();
  ensureShippedDarkAuditBootHook();
}
