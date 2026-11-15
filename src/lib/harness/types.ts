import type { ReviewRunEvidence, ReviewMode } from '@/lib/orchestrator/review-run-evidence';
export const HARNESS_BUNDLE_SCHEMA = 'o8/harness-bundle/v1' as const;
export const HARNESS_CAPABILITIES_SCHEMA = 'o8/harness-capabilities/v1' as const;

export type HarnessFeatureStatus = 'failing' | 'passing' | 'blocked';
export type HarnessCheckStatus = 'passed' | 'failed' | 'skipped';
export type HarnessContractStatus = 'proposed' | 'accepted' | 'verified' | 'failed' | 'superseded';
export type HarnessSprintStatus = 'active' | 'blocked' | 'completed';
export type HarnessComponentLifecycle = 'retained' | 'candidate' | 'shadow_only' | 'retired';

export interface HarnessFeature {
  id: string;
  repoPath: string;
  title: string;
  description: string;
  priority: number;
  status: HarnessFeatureStatus;
  verificationCommand: string[] | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  latestCheck: HarnessFeatureCheck | null;
}

export interface HarnessFeatureCheck {
  id: string;
  featureId: string;
  status: HarnessCheckStatus;
  evidence: string;
  command: string[] | null;
  exitCode: number | null;
  modelId: string | null;
  packetId: string | null;
  createdAt: number;
}

export interface GroundedPath {
  path: string;
  score: number;
  reasons: string[];
  symbols: string[];
}

export interface HarnessGroundingArtifact {
  schema: 'o8/grounding/v1';
  id: string;
  repoPath: string;
  task: string;
  featureId: string | null;
  packetId: string | null;
  git: {
    head: string | null;
    branch: string | null;
    dirty: boolean;
  };
  queryTerms: string[];
  paths: GroundedPath[];
  repositoryInstructions: string[];
  acceptanceCriteria: string[];
  warnings: string[];
  createdAt: number;
}

export interface HarnessContract {
  id: string;
  repoPath: string;
  featureId: string | null;
  groundingId: string | null;
  generatorTerms: string;
  evaluatorTerms: string;
  acceptanceCriteria: string[];
  status: HarnessContractStatus;
  proposedBy: string | null;
  acceptedBy: string | null;
  createdAt: number;
  acceptedAt: number | null;
  updatedAt: number;
}

export interface HarnessSprintEvent {
  at: number;
  type: 'started' | 'advanced' | 'blocked' | 'completed' | 'verification';
  featureId?: string | null;
  note?: string;
}

export interface HarnessSprint {
  id: string;
  repoPath: string;
  contractId: string;
  packetId: string | null;
  currentFeatureId: string | null;
  status: HarnessSprintStatus;
  tickCount: number;
  events: HarnessSprintEvent[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface HarnessComponentState {
  componentKey: string;
  modelId: string;
  lifecycle: HarnessComponentLifecycle;
  reason: string;
  updatedAt: number;
  measurementCount: number;
  weightedLift: number | null;
  recommendation: HarnessLifecycleRecommendation;
}

export interface HarnessMeasurement {
  id: string;
  componentKey: string;
  modelId: string;
  baselineScore: number;
  enabledScore: number;
  lift: number;
  sampleCount: number;
  evidence: Record<string, unknown>;
  createdAt: number;
}

export interface HarnessLifecycleRecommendation {
  action: 'retain' | 'candidate' | 'shadow_only' | 'retire' | 'rearm' | 'measure_more';
  reason: string;
}

export interface HarnessCapabilities {
  schema: typeof HARNESS_CAPABILITIES_SCHEMA;
  version: 1;
  artifacts: Array<{
    id: string;
    description: string;
    cli: string[];
    mcp: string[];
  }>;
  recommendedCallOrder: string[];
  componentGuidance: HarnessComponentState[];
  limits: {
    evaluatorDiffBytes: number;
    groundingFilesScanned: number;
    bundleVersion: 1;
  };
}

export interface HarnessBundleV1 {
  schema: typeof HARNESS_BUNDLE_SCHEMA;
  exportedAt: number;
  sourceRepoPath: string;
  features: Array<Omit<HarnessFeature, 'repoPath' | 'latestCheck'> & { checks: HarnessFeatureCheck[] }>;
  groundings: HarnessGroundingArtifact[];
  contracts: Array<Omit<HarnessContract, 'repoPath'>>;
  components: HarnessComponentState[];
  measurements: HarnessMeasurement[];
}

export type HarnessEvaluationVerdict = 'approve' | 'request_changes' | 'inconclusive';

export interface HarnessEvaluationFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
}

export interface HarnessEvaluationResult {
  runEvidence: ReviewRunEvidence;
  reviewMode: ReviewMode;
  verdictLabel: string;
  schema: 'o8/evaluate-diff/v1';
  verdict: HarnessEvaluationVerdict;
  summary: string;
  findings: HarnessEvaluationFinding[];
  risk: 'standard' | 'high';
  riskReasons: string[];
  reviewerBackend: string | null;
  reviewedAt: number;
}
