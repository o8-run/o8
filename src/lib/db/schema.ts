/**
 * Database Schema — Foundation for Monetization
 *
 * SQLite for local/dev, designed to map cleanly to PostgreSQL for production.
 * All monetization features (auth, billing, usage, teams) depend on these tables.
 *
 * Issue: https://github.com/o8-run/o8/issues/217
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { desc, sql } from 'drizzle-orm';
import {
  ORCHESTRATOR_RUNTIME_IDS,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { workerTokenColumns } from './worker-token-schema';

export * from './harness-schema';
export * from './workspace-snapshot-schema';
export * from './storage-admission-schema';
export * from './broadcast-schema';
export * from './explainer-queue-schema';
export * from './automation-schema';
const ORCHESTRATOR_RUNTIME_ENUM = [...ORCHESTRATOR_RUNTIME_IDS] as [
  OrchestratorRuntime,
  ...OrchestratorRuntime[],
];

// ══════════════════════════════════════════════════════════════════
//  Users — core identity
// ══════════════════════════════════════════════════════════════════

export const users = sqliteTable('users', {
  /** UUID primary key */
  id: text('id').primaryKey(),
  /** GitHub user ID (unique, nullable for email-only users) */
  githubId: integer('github_id').unique(),
  /** Discord user ID (unique, nullable) */
  discordId: text('discord_id').unique(),
  /** Clerk user ID (unique, nullable) — identity source-of-truth when Clerk is configured */
  clerkUserId: text('clerk_user_id').unique(),
  /** Email address */
  email: text('email').unique(),
  /** Display name */
  name: text('name'),
  /** Avatar URL (from GitHub/Discord) */
  avatarUrl: text('avatar_url'),
  /** Plan tier: free | pro | team */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Monthly token budget in USD (null = unlimited for BYOK) */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Created timestamp (ISO 8601) */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** Last updated timestamp */
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  /** Last login timestamp */
  lastLoginAt: text('last_login_at'),
});

// ══════════════════════════════════════════════════════════════════
//  API Keys — BYOK storage (encrypted at rest)
// ══════════════════════════════════════════════════════════════════

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** LLM provider: anthropic | openai | google */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google'] }).notNull(),
  /** Encrypted API key (AES-256-GCM, key from env) */
  encryptedKey: text('encrypted_key').notNull(),
  /** IV for decryption */
  iv: text('iv').notNull(),
  /** Label (user-friendly name, e.g. "Work key") */
  label: text('label'),
  /** Is this the active key for this provider? */
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Usage Logs — token metering per request
// ══════════════════════════════════════════════════════════════════

export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Model used (e.g. claude-opus-4-6, gpt-5.5) */
  model: text('model').notNull(),
  /** LLM provider */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google', 'openrouter', 'opencode', 'runtime'] }).notNull(),
  /** Input tokens consumed */
  inputTokens: integer('input_tokens').notNull().default(0),
  /** Output tokens consumed */
  outputTokens: integer('output_tokens').notNull().default(0),
  /** Cache read tokens (Anthropic) */
  cacheReadTokens: integer('cache_read_tokens').default(0),
  /** Cache write tokens (Anthropic) */
  cacheWriteTokens: integer('cache_write_tokens').default(0),
  /** Computed cost in USD */
  costUsd: real('cost_usd').notNull().default(0),
  /** Associated agent session key */
  sessionKey: text('session_key'),
  /** Durable orchestration context. Nullable for legacy and global rows. */
  laneId: text('lane_id'),
  packetId: text('packet_id'),
  missionId: text('mission_id'),
  /** Role played by this model call inside the orchestration pipeline. */
  role: text('role', { enum: ['orchestrator', 'worker', 'reviewer', 'compaction', 'retrieval', 'other'] }),
  /** One-based packet attempt index. */
  attempt: integer('attempt').notNull().default(1),
  /** Runtime-owned execution receipt when one exists. */
  runId: text('run_id'),
  /** Optional metering provenance, including whether token counts are estimated. */
  metadataJson: text('metadata_json'),
  /** Repository where the session ran */
  repoPath: text('repo_path'),
  /** Agent name (for breakdown) */
  agentName: text('agent_name'),
  /** Request type: chat | completion | embedding */
  requestType: text('request_type', { enum: ['chat', 'completion', 'embedding'] }).default('chat'),
  /** Billing period (YYYY-MM for monthly rollups) */
  billingPeriod: text('billing_period').notNull(),
  /** Timestamp */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  packetAttemptIdx: index('idx_usage_logs_packet_attempt').on(table.packetId, table.attempt),
}));

// ══════════════════════════════════════════════════════════════════
//  Subscriptions — Stripe billing link
// ══════════════════════════════════════════════════════════════════

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  /** Stripe customer ID */
  stripeCustomerId: text('stripe_customer_id').unique(),
  /** Stripe subscription ID */
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  /** Plan at Stripe level */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Subscription status */
  status: text('status', { enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'] }).notNull().default('active'),
  /** Current period end (ISO 8601) */
  currentPeriodEnd: text('current_period_end'),
  /** Whether subscription auto-cancels at period end */
  cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Sessions — auth sessions (JWT tracking)
// ══════════════════════════════════════════════════════════════════

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Hashed refresh token */
  tokenHash: text('token_hash').notNull(),
  /** User agent string */
  userAgent: text('user_agent'),
  /** IP address */
  ipAddress: text('ip_address'),
  /** Expires at (ISO 8601) */
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Session Outcomes — durable session ledger entries
// ══════════════════════════════════════════════════════════════════

export const sessionOutcomes = sqliteTable('session_outcomes', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  repoPath: text('repo_path').notNull(),
  branch: text('branch'),
  runtime: text('runtime', { enum: ORCHESTRATOR_RUNTIME_ENUM }).notNull(),
  sessionKey: text('session_key'),
  laneId: text('lane_id'),
  packetId: text('packet_id'),
  outcome: text('outcome', { enum: ['succeeded', 'failed', 'partial', 'interrupted', 'adopted_elsewhere', 'superseded', 'spec_changed', 'wontfix'] }).notNull(),
  summary: text('summary').notNull(),
  memoryFingerprint: text('memory_fingerprint'),
  planText: text('plan_text'),
  attempts: integer('attempts').notNull().default(1),
  retryHistoryJson: text('retry_history_json').notNull().default('[]'),
  durationMs: integer('duration_ms'),
  totalTokens: integer('total_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  model: text('model'),
  patternsJson: text('patterns_json').notNull().default('[]'),
  conflictZonesJson: text('conflict_zones_json').notNull().default('[]'),
  changedFilesJson: text('changed_files_json').notNull().default('[]'),
  reviewApproved: integer('review_approved', { mode: 'boolean' }),
  reviewFindingsCount: integer('review_findings_count').notNull().default(0),
  transcriptPath: text('transcript_path'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /**
   * #745 — Temporal validity windows. `valid_from` defaults to NOW; `valid_to`
   * is NULL for live entries and gets stamped to NOW once the row decays
   * (no confirmations within 30d) or is superseded by a fresher outcome on
   * the same `(repo_path, file_path, symbol)` tuple.
   */
  validFrom: text('valid_from').notNull().default(sql`(datetime('now'))`),
  validTo: text('valid_to'),
  /**
   * #747 — Per-runtime outcome shape used by the dispatch routing recommender.
   * Nullable because legacy rows (before v12) don't carry the signal. The
   * `recommendRuntime()` helper coalesces to "no opinion" when these are NULL.
   *
   *  - `skippedTests`  — true when the agent skipped or stubbed required tests
   *  - `reworked`      — true when the operator had to rerun-with-feedback
   *                      before accepting (or rejected outright)
   *  - `mergedClean`   — true when the diff merged without operator edits and
   *                      `review_approved = true`. The headline routing signal.
   */
  skippedTests: integer('skipped_tests', { mode: 'boolean' }),
  reworked: integer('reworked', { mode: 'boolean' }),
  mergedClean: integer('merged_clean', { mode: 'boolean' }),
}, (table) => ({
  repoRuntimeIdx: index('idx_so_repo_runtime').on(table.repoPath, table.runtime, table.completedAt),
  repoCompletedIdx: index('idx_so_repo_completed').on(table.repoPath, table.completedAt),
  projectIdIdx: index('idx_session_outcomes_project_id').on(table.projectId),
  laneIdIdx: index('idx_so_lane_id').on(table.laneId),
  packetIdIdx: index('idx_so_packet_id').on(table.packetId),
  validToIdx: index('idx_so_valid_to').on(table.validTo),
}));

// ══════════════════════════════════════════════════════════════════
//  Chat History — mirrored session ledger for persisted transcripts
// ══════════════════════════════════════════════════════════════════

export const chatHistory = sqliteTable('chat_history', {
  tabId: text('tab_id').primaryKey(),
  messagesJson: text('messages_json').notNull().default('[]'),
  model: text('model'),
  savedAt: text('saved_at'),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
  starred: integer('starred', { mode: 'boolean' }).notNull().default(false),
  title: text('title'),
  planText: text('plan_text'),
  repoName: text('repo_name'),
  repoPath: text('repo_path'),
  repoBranch: text('repo_branch'),
  remoteUrl: text('remote_url'),
}, (table) => ({
  modifiedAtIdx: index('idx_chat_history_modified_at').on(table.modifiedAt),
  repoPathIdx: index('idx_chat_history_repo_path').on(table.repoPath),
}));

// ══════════════════════════════════════════════════════════════════
//  Teams — multi-user organizations
// ══════════════════════════════════════════════════════════════════

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Owner user ID */
  ownerId: text('owner_id').notNull().references(() => users.id),
  /** Slug for URL (team identifier) */
  slug: text('slug').unique(),
  /** Pooled token budget in USD per month */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Max seats */
  maxSeats: integer('max_seats').default(10),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Member role */
  role: text('role', { enum: ['owner', 'admin', 'member', 'readonly'] }).notNull().default('member'),
  joinedAt: text('joined_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Waitlist — pre-launch signups
// ══════════════════════════════════════════════════════════════════

export const waitlist = sqliteTable('waitlist', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  githubUsername: text('github_username'),
  source: text('source'), // where they heard about us
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  GitHub Broker — durable remote snapshots for local and prod
// ══════════════════════════════════════════════════════════════════

export const githubInstallations = sqliteTable('github_installations', {
  installationId: integer('installation_id').primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type'),
  targetType: text('target_type'),
  permissionsJson: text('permissions_json'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubRepositories = sqliteTable('github_repositories', {
  repoId: integer('repo_id').primaryKey(),
  fullName: text('full_name').notNull().unique(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  private: integer('private', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch'),
  installationId: integer('installation_id').references(() => githubInstallations.installationId, { onDelete: 'set null' }),
  lastWebhookAt: text('last_webhook_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubSyncState = sqliteTable('github_sync_state', {
  key: text('key').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  resource: text('resource').notNull(),
  etag: text('etag'),
  lastSyncedAt: text('last_synced_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastError: text('last_error'),
  staleAt: text('stale_at'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubIssues = sqliteTable('github_issues', {
  issueId: integer('issue_id').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  authorLogin: text('author_login'),
  body: text('body'),
  labelsJson: text('labels_json').notNull().default('[]'),
  assigneesJson: text('assignees_json').notNull().default('[]'),
  commentsCount: integer('comments_count').notNull().default(0),
  url: text('url').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  closedAt: text('closed_at'),
  lastHumanCommentAuthorLogin: text('last_human_comment_author_login'),
  lastHumanCommentAuthorAssociation: text('last_human_comment_author_association'),
  lastHumanCommentAt: text('last_human_comment_at'),
  lastInsiderCommentAt: text('last_insider_comment_at'),
});

export const githubPullRequests = sqliteTable('github_pull_requests', {
  pullRequestId: integer('pull_request_id').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  authorLogin: text('author_login'),
  body: text('body'),
  headRefName: text('head_ref_name'),
  headSha: text('head_sha'),
  mergeCommit: text('merge_commit'),
  baseRefName: text('base_ref_name'),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
  changedFiles: integer('changed_files').notNull().default(0),
  reviewDecision: text('review_decision'),
  statusChecksJson: text('status_checks_json').notNull().default('[]'),
  url: text('url').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  closedAt: text('closed_at'),
  mergedAt: text('merged_at'),
  lastHumanCommentAuthorLogin: text('last_human_comment_author_login'),
  lastHumanCommentAuthorAssociation: text('last_human_comment_author_association'),
  lastHumanCommentAt: text('last_human_comment_at'),
  lastInsiderCommentAt: text('last_insider_comment_at'),
});

// ══════════════════════════════════════════════════════════════════
//  Approvals — durable approval and audit history
// ══════════════════════════════════════════════════════════════════

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  source: text('source', { enum: ['llm-chat', 'runtime', 'test'] }).notNull(),
  runtime: text('runtime').notNull(),
  agent: text('agent').notNull(),
  sessionKey: text('session_key').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  summary: text('summary').notNull(),
  toolName: text('tool_name'),
  argsJson: text('args_json'),
  command: text('command'),
  editable: integer('editable', { mode: 'boolean' }),
  diffJson: text('diff_json'),
  gateResultJson: text('gate_result_json'),
  conflictReportJson: text('conflict_report_json'),
  risk: text('risk', { enum: ['low', 'medium', 'high'] }).notNull(),
  metadataJson: text('metadata_json'),
  packetId: text('packet_id'),
  laneId: text('lane_id'),
  policyRuleId: text('policy_rule_id'),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  resolvedAt: integer('resolved_at'),
  resolutionJson: text('resolution_json'),
  auditJson: text('audit_json').notNull().default('[]'),
  fingerprint: text('fingerprint').notNull(),
  continuationJson: text('continuation_json'),
}, (table) => ({
  statusCreatedIdx: index('idx_approvals_status_created').on(table.status, table.createdAt),
  projectIdIdx: index('idx_approvals_project_id').on(table.projectId),
  sessionKeyCreatedIdx: index('idx_approvals_session_key_created').on(table.sessionKey, table.createdAt),
  packetIdIdx: index('idx_approvals_packet_id').on(table.packetId),
  laneIdIdx: index('idx_approvals_lane_id').on(table.laneId),
  fingerprintStatusIdx: index('idx_approvals_fingerprint_status').on(table.fingerprint, table.status),
  resolvedAtIdx: index('idx_approvals_resolved_at').on(table.resolvedAt),
}));

// ══════════════════════════════════════════════════════════════════
//  Lane Registry — durable multi-process orchestration state
// ══════════════════════════════════════════════════════════════════

export const lanes = sqliteTable('lanes', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  label: text('label').notNull(),
  repoPath: text('repo_path').notNull(),
  worktreePath: text('worktree_path'),
  branch: text('branch').notNull(),
  baseBranch: text('base_branch').notNull(),
  runtime: text('runtime', { enum: ORCHESTRATOR_RUNTIME_ENUM }).notNull(),
  model: text('model'),
  sessionKey: text('session_key'),
  packetId: text('packet_id'),
  prNumber: integer('pr_number'),
  status: text('status', {
    enum: ['idle', 'launching', 'running', 'paused', 'awaiting_input', 'awaiting_orchestrator', 'awaiting_human', 'recovering', 'reviewing', 'merging', 'failed', 'completed', 'archived'],
  }).notNull(),
  outcome: text('outcome', { enum: ['no_changes', 'merged', 'discarded', 'closed_unmerged', 'pr_opened', 'asked', 'archived_recoverable'] }),
  outcomeNote: text('outcome_note'),
  ownership: text('ownership', { enum: ['managed', 'attached'] }).notNull(),
  writerToken: text('writer_token'),
  lastHeartbeatAt: integer('last_heartbeat_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastEventAt: text('last_event_at'),
  lastEventLabel: text('last_event_label'),
}, (table) => ({
  sessionKeyIdx: index('idx_lanes_session_key').on(table.sessionKey),
  projectIdIdx: index('idx_lanes_project_id').on(table.projectId),
  packetIdIdx: index('idx_lanes_packet_id').on(table.packetId),
  repoBranchStatusIdx: index('idx_lanes_repo_branch_status').on(table.repoPath, table.branch, table.status),
  statusIdx: index('idx_lanes_status').on(table.status),
}));

export const dispatchRules = sqliteTable('dispatch_rules', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  packetType: text('packet_type').notNull(),
  ruleText: text('rule_text').notNull(),
  source: text('source', { enum: ['review', 'file', 'manual'] }).notNull(),
  signalScore: real('signal_score').notNull().default(1),
  promotedAt: text('promoted_at'),
  demotedAt: text('demoted_at'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
}, (table) => ({
  repoPathPacketTypeIdx: index('idx_dispatch_rules_repo_path_packet_type').on(table.repoPath, table.packetType),
  signalScoreIdx: index('idx_dispatch_rules_signal_score_desc').on(desc(table.signalScore)),
}));

export const workerTokens = sqliteTable('worker_tokens', workerTokenColumns(), (table) => ({
  packetIdIdx: index('idx_worker_tokens_packet_id').on(table.packetId),
}));

export const workerRuns = sqliteTable('worker_runs', {
  id: text('id').primaryKey(),
  laneId: text('lane_id').notNull().references(() => lanes.id, { onDelete: 'cascade' }),
  workerTokenId: text('worker_token_id').notNull().references(() => workerTokens.id, { onDelete: 'cascade' }),
  transport: text('transport').notNull(),
  status: text('status').notNull(),
  remoteBranch: text('remote_branch'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  lastEventAt: text('last_event_at').notNull(),
  errorJson: text('error_json'),
}, (table) => ({
  laneIdIdx: index('idx_worker_runs_lane_id').on(table.laneId),
  statusIdx: index('idx_worker_runs_status').on(table.status),
}));

export const workerEvents = sqliteTable('worker_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workerRunId: text('worker_run_id').notNull().references(() => workerRuns.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  runCreatedIdx: index('idx_worker_events_run_created').on(table.workerRunId, table.createdAt),
}));

// ══════════════════════════════════════════════════════════════════
//  External MCP Servers — user-configured orchestrator context sources
// ══════════════════════════════════════════════════════════════════

export const externalMcpServers = sqliteTable('external_mcp_servers', {
  id: text('id').primaryKey(),
  /** Optional team scoping — null means global (user-level) */
  teamId: text('team_id'),
  name: text('name').notNull().unique(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  /** stdio: binary/command path. http: treated as url field alias. */
  command: text('command').notNull(),
  args: text('args').notNull().default('[]'),
  envJson: text('env_json'),
  /** HTTP transport: explicit URL field (mirrors command for http servers) */
  url: text('url'),
  /** OAuth bearer token for authenticated HTTP MCP servers (stored as-is; users paste it) */
  oauthToken: text('oauth_token'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  workerInjection: integer('worker_injection', { mode: 'boolean' }).notNull().default(false),
  symonInjection: integer('symon_injection', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  enabledIdx: index('idx_external_mcp_servers_enabled').on(table.enabled),
  updatedAtIdx: index('idx_external_mcp_servers_updated_at').on(table.updatedAt),
  teamIdIdx: index('idx_external_mcp_servers_team_id').on(table.teamId),
}));

export const approvalEvents = sqliteTable('approval_events', {
  id: text('id').primaryKey(),
  approvalId: text('approval_id').notNull(),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  note: text('note'),
  detailsJson: text('details_json').notNull().default('{}'),
  timestamp: integer('timestamp').notNull(),
}, (table) => ({
  approvalTimestampIdx: index('idx_approval_events_approval_timestamp').on(table.approvalId, table.timestamp),
}));

// ══════════════════════════════════════════════════════════════════
//  Review Queue — durable auto-review queue (survives restarts)
// ══════════════════════════════════════════════════════════════════

export const reviewQueue = sqliteTable('review_queue', {
  id: text('id').primaryKey(),
  laneId: text('lane_id').notNull(),
  repoPath: text('repo_path').notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  headSha: text('head_sha'),
  claimedAt: text('claimed_at'),
  claimOwner: text('claim_owner'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  statusIdx: index('idx_review_queue_status').on(table.status),
  laneIdIdx: index('idx_review_queue_lane_id').on(table.laneId),
  laneStatusIdx: index('idx_review_queue_lane_status').on(table.laneId, table.status),
}));

// ══════════════════════════════════════════════════════════════════
//  Beta Founding Invites — the operator's set of share-able beta passes
//  (#beta-referral). Generated + persisted locally; hosted redemption is
//  optional.
// ══════════════════════════════════════════════════════════════════

export const betaInvites = sqliteTable('beta_invites', {
  code: text('code').primaryKey(),
  owner: text('owner').notNull().default('operator'),
  accent: text('accent').notNull(),
  position: integer('position').notNull(),
  status: text('status', { enum: ['available', 'sent', 'redeemed'] }).notNull().default('available'),
  sentAt: text('sent_at'),
  redeemedAt: text('redeemed_at'),
  redeemedBy: text('redeemed_by'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  ownerIdx: index('idx_beta_invites_owner').on(table.owner),
}));

// ══════════════════════════════════════════════════════════════════
//  Watched Agents — durable supervisor state (survives restarts)
// ══════════════════════════════════════════════════════════════════

export const watchedAgents = sqliteTable('watched_agents', {
  surfaceId: text('surface_id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull().default(''),
  registeredAt: integer('registered_at').notNull(),
  lastStatus: text('last_status').notNull().default('running'),
  retryCount: integer('retry_count').notNull().default(0),
  steerCount: integer('steer_count').notNull().default(0),
  completionReported: integer('completion_reported', { mode: 'boolean' }).notNull().default(false),
  lastEventAt: integer('last_event_at').notNull().default(0),
  lastActivityAt: integer('last_activity_at').notNull(),
});

export const laneEvents = sqliteTable('lane_events', {
  id: text('id').primaryKey(),
  laneId: text('lane_id').notNull().references(() => lanes.id, { onDelete: 'cascade' }),
  verb: text('verb').notNull(),
  actor: text('actor', { enum: ['user', 'orchestrator', 'system'] }).notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  timestamp: text('timestamp').notNull(),
}, (table) => ({
  laneTimestampIdx: index('idx_lane_events_lane_timestamp').on(table.laneId, table.timestamp),
  timestampIdx: index('idx_lane_events_timestamp').on(table.timestamp),
}));

export const supervisorInbox = sqliteTable('supervisor_inbox', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  incidentKey: text('incident_key'),
  repoPath: text('repo_path').notNull(),
  packetId: text('packet_id'),
  kind: text('kind', {
    enum: ['verification_failed', 'session_lost', 'packet_missing', 'bounded_retry_exhausted', 'merge_blocked', 'fetch_unreachable', 'repo_misconfigured', 'silent_exit_verification_failed', 'silent_exit_no_work', 'silent_exit_but_work_present', 'worker_quota_exhausted', 'outside_human_waiting'],
  }).notNull(),
  payload: text('payload').notNull().default('{}'),
  status: text('status', {
    enum: ['pending', 'healing', 'self_healed', 'escalated', 'resolved', 'human_required', 'dismissed'],
  }).notNull().default('pending'),
  healAttemptCount: integer('heal_attempt_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  lastSeenAt: text('last_seen_at'),
  repeatCount: integer('repeat_count').notNull().default(1),
  resolvedAt: text('resolved_at'),
  resolutionLaneId: text('resolution_lane_id'),
}, (table) => ({
  statusCreatedIdx: index('idx_supervisor_inbox_status_created').on(table.status, table.createdAt),
  projectStatusCreatedIdx: index('idx_supervisor_inbox_project_status_created').on(table.projectId, table.status, table.createdAt),
  incidentStatusIdx: index('idx_supervisor_inbox_incident_status').on(table.incidentKey, table.status),
  packetIdIdx: index('idx_supervisor_inbox_packet_id').on(table.packetId),
  repoCreatedIdx: index('idx_supervisor_inbox_repo_created').on(table.repoPath, table.createdAt),
}));

// ══════════════════════════════════════════════════════════════════
//  Push Subscriptions — mobile Web Push (issue #639)
// ══════════════════════════════════════════════════════════════════

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  /** PushSubscription endpoint URL — uniquely identifies the browser */
  endpoint: text('endpoint').primaryKey(),
  /** Base64url-encoded P256DH public key (browser key) */
  p256dh: text('p256dh').notNull(),
  /** Base64url-encoded auth secret */
  auth: text('auth').notNull(),
  /** Optional user agent string for diagnostics */
  userAgent: text('user_agent'),
  /** Optional human label (e.g. "iPhone 15 — Safari") */
  label: text('label'),
  /** Optional webhook URL for fallback delivery (ntfy.sh / Pushover / Discord) */
  webhookUrl: text('webhook_url'),
  /** Last successful delivery timestamp (ms epoch) */
  lastDeliveredAt: integer('last_delivered_at'),
  /** Number of consecutive delivery failures (used to expire subs) */
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  createdAtIdx: index('idx_push_subscriptions_created_at').on(table.createdAt),
}));

// ══════════════════════════════════════════════════════════════════
//  Mobile Live Activity Tokens — ActivityKit push updates
// ══════════════════════════════════════════════════════════════════

export const mobileLiveActivityTokens = sqliteTable('mobile_live_activity_tokens', {
  /** ActivityKit push token hex string for one active Live Activity. */
  pushToken: text('push_token').primaryKey(),
  /** Native ActivityKit id, when the client can observe it. */
  activityId: text('activity_id'),
  /** App bundle id used to build the APNs liveactivity topic. */
  bundleId: text('bundle_id').notNull(),
  /** APNs environment for this token. */
  environment: text('environment', { enum: ['sandbox', 'production'] }).notNull().default('sandbox'),
  /** Optional human label for diagnostics. */
  deviceLabel: text('device_label'),
  /** Last payload signature pushed to avoid duplicate APNs updates. */
  lastSignature: text('last_signature'),
  /** Last successful delivery timestamp (ms epoch). */
  lastDeliveredAt: integer('last_delivered_at'),
  /** Consecutive APNs delivery failures. */
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  updatedAtIdx: index('idx_mobile_live_activity_tokens_updated_at').on(table.updatedAt),
}));

/**
 * Schema v27 — visual verification artifacts. An agent (or the review-boundary
 * hook) captures a screenshot/video proving a bug reproduces or a fix works;
 * the row points at bytes on disk under `<dataDir>/artifacts/<packetId>/`. The
 * artifact rides back to the orchestrator in the packet status payload and
 * surfaces as a before/after strip in the review / PR / packet-card surfaces.
 * Path is stored RELATIVE to the data dir (clone-safe — never an absolute
 * /Users/... path).
 */
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  /** 'screenshot' | 'video' — v1 ships screenshot only. */
  kind: text('kind').notNull().default('screenshot'),
  /** Origin: 'agent-capture' (o8 packet capture) | 'review-boundary' | 'manual'. */
  source: text('source').notNull(),
  laneId: text('lane_id'),
  packetId: text('packet_id'),
  repoPath: text('repo_path'),
  prNumber: integer('pr_number'),
  threadId: text('thread_id'),
  /** Human label ("login screen — bug", "after fix"). */
  label: text('label'),
  /** 'before' | 'after' | null — drives the before/after strip pairing. */
  phase: text('phase', { enum: ['before', 'after'] }),
  /** Groups a before/after pair captured for the same check. */
  pairId: text('pair_id'),
  /** Path RELATIVE to the o8 data dir, e.g. `artifacts/<packetId>/<id>.png`. */
  relPath: text('rel_path').notNull(),
  mimeType: text('mime_type').notNull().default('image/png'),
  width: integer('width'),
  height: integer('height'),
  bytes: integer('bytes'),
  /** Set once mirrored into a GitHub PR comment (best-effort). */
  ghCommentUrl: text('gh_comment_url'),
  capturedAt: text('captured_at').notNull().default(sql`(datetime('now'))`),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  packetIdx: index('idx_artifacts_packet').on(table.packetId, table.capturedAt),
  prIdx: index('idx_artifacts_pr').on(table.prNumber, table.capturedAt),
  laneIdx: index('idx_artifacts_lane').on(table.laneId, table.capturedAt),
  threadIdx: index('idx_artifacts_thread').on(table.threadId, table.capturedAt),
}));

/**
 * Schema v32 (#1497) — persisted idempotency keys for orchestrator control
 * verbs (steer / rerun / retry / dispatch — and, since v33, merge). Replaces
 * the in-memory-only guard that (a) only covered merge and (b) evaporated on
 * restart — a timed-out rerun retry double-dispatched into two parallel clones.
 * A row is RESERVED (result_json NULL) the instant a verb starts and FINALIZED
 * with the JSON result on success; a concurrent duplicate that finds a reserved
 * row is told "in progress, not re-executed" instead of forking a second
 * worker. Rows self-expire via `expires_at` (~10-min TTL) and are pruned on
 * access.
 *
 * Schema v33 (#1513) — `pid` column: the process id that owns an in-flight
 * reservation. The in-memory merge cache deliberately forgot in-flight merges
 * on restart so the operator could retry immediately; the persisted store must
 * not regress that. On store/DB init we reap reservations (result_json NULL)
 * whose owning `pid` is dead (kill(pid,0)→ESRCH), so a restart-interrupted
 * merge becomes immediately retryable while a LIVE in-flight duplicate is still
 * deduped.
 */
export const idempotencyKeys = sqliteTable('idempotency_keys', {
  /** Derived key: explicit client key, else hash(verb + scopeId + body). PK. */
  key: text('key').primaryKey(),
  verb: text('verb').notNull(),
  /** packetId for packet-scoped verbs; missionId (or '') for dispatch. */
  packetId: text('packet_id'),
  /** JSON-serialized original result. NULL while the verb is still in flight. */
  resultJson: text('result_json'),
  /** OS pid that reserved the row. NULL for finalized rows / legacy inserts. */
  pid: integer('pid'),
  reservationId: text('reservation_id'),
  ownerIdentityJson: text('owner_identity_json'),
  /** ms-epoch stamps (integers, not ISO — this table is machine-only). */
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (table) => ({
  expiresIdx: index('idx_idempotency_expires').on(table.expiresAt),
}));
