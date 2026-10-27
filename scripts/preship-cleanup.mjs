#!/usr/bin/env node
/** Read-only collision guard. Producer termination and lock disposal require separate authority. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertNoProducer } from './lib/generated-output-producer-check.mjs';

const require = createRequire(import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const absolute = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && value !== path.parse(value).root;
const processIdentity = receipt => receipt && receipt.version === 1
  && ['darwin', 'linux', 'win32'].includes(receipt.platform)
  && [receipt.bootId, receipt.startId].every(part => typeof part === 'string'
    && part.length > 0 && part.length <= 160 && /^[\x20-\x7e]+$/.test(part));

/** Accept only the narrow quiet, managed subset of the canonical resource schema. */
function assertQuietManagedResource(resource) {
  if (resource.origin !== 'managed-creation' || !uuid.test(resource.resourceId)
    || !integer(resource.version, 1) || !integer(resource.createdAt, 1)
    || !integer(resource.updatedAt, resource.createdAt)
    || !(resource.owner ? absolute(resource.owner.repositoryPath)
      : resource.creationAuthority?.kind === 'prebuild' && integer(resource.creationAuthority.pid, 1)
        && processIdentity(resource.creationAuthority.identity))
    || !resource.revision || !/^[0-9a-f]{40,64}$/.test(resource.revision.head)
    || !/^[0-9a-f]{40,64}$/.test(resource.revision.tree)
    || typeof resource.revision.dirty !== 'boolean' || !sha.test(resource.revision.workingDigest)
    || resource.adoption || resource.bank || resource.bankCapture || resource.recovery || resource.retirement
    || !resource.output || resource.output.device !== resource.workspace.device
    || resource.output.inode === resource.workspace.inode) {
    throw new Error('generated-output managed authority is invalid or retained');
  }
  if (resource.state === 'ready' && !resource.attempt) return;
  const attempt = resource.attempt;
  if (!['ready', 'succeeded'].includes(resource.state) || !attempt || !uuid.test(attempt.id)
    || !['build', 'dev', 'start'].includes(attempt.mode) || !integer(attempt.ownerPid, 1)
    || !processIdentity(attempt.ownerIdentity) || !Array.isArray(attempt.children)
    || attempt.children.length < 1 || attempt.children.length > 16) {
    throw new Error('generated output lacks a coherent quiet producer receipt');
  }
  const pids = new Set();
  const stopSignals = new Set();
  for (const child of attempt.children) {
    if (!integer(child.pid, 1) || pids.has(child.pid) || !processIdentity(child.identity)
      || child.observedClosed !== true
      || !((child.exitCode === 0 && child.signal === null)
        || (attempt.mode !== 'build' && child.exitCode === null
          && ['SIGINT', 'SIGTERM'].includes(child.signal)))) {
      throw new Error('generated output lacks observed successful producer exits');
    }
    pids.add(child.pid);
    if (child.signal) stopSignals.add(child.signal);
  }
  if (stopSignals.size > 1 || (resource.state === 'ready' && (attempt.mode === 'build'
    || (attempt.mode !== 'start' && stopSignals.size === 0)))) {
    throw new Error('ready output lacks an observed successful start or controlled stop');
  }
}

function statIfPresent(file) {
  try { return lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertIdentity(directory, expected) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !expected
    || expected.canonicalPath !== realpathSync(directory)
    || expected.device !== stat.dev || expected.inode !== stat.ino) {
    throw new Error('generated-output directory identity is unknown or changed');
  }
}

function assertOwnedOutput(workspace, output) {
  const marker = path.join(workspace, '.o8-generated-output-store');
  const markerStat = statIfPresent(marker);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size !== 64) {
    throw new Error('existing generated output has unknown lifecycle ownership');
  }
  // Resolve without invoking the data-dir migration or the writable application DB initializer.
  const profile = process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(homedir(), '.o8');
  const databasePath = realpathSync(process.env.CORTEX_IDE_DB_PATH || path.join(profile, 'cortex-ide.db'));
  const binding = createHash('sha256').update(databasePath).digest('hex');
  if (readFileSync(marker, 'utf8') !== binding) throw new Error('generated output belongs to a different lifecycle store');
  const Database = require('better-sqlite3');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasRetentionIndex = database.prepare('PRAGMA table_info(workspace_generated_outputs)').all()
      .some(column => column.name === 'retained_operation_id');
    const rows = database.prepare(`SELECT * FROM workspace_generated_outputs
      WHERE workspace_path = ? AND state != 'retired'${hasRetentionIndex ? ' AND retained_operation_id IS NULL' : ''}`).all(workspace);
    if (rows.length !== 1 || Buffer.byteLength(rows[0].payload_json) > 16 * 1024 ** 2) {
      throw new Error('generated-output lifecycle resource is unknown');
    }
    const row = rows[0];
    const resource = JSON.parse(row.payload_json);
    if (resource.schema !== 'o8/generated-output-resource/v1' || resource.resourceId !== row.resource_id
      || resource.state !== row.state || resource.version !== row.version
      || resource.createdAt !== row.created_at || resource.updatedAt !== row.updated_at
      || (resource.owner && (!path.isAbsolute(resource.owner.repositoryPath || '')
        || resource.owner.worktreeId !== path.basename(workspace)))
      || !['ready', 'succeeded'].includes(resource.state) || resource.bank || resource.bankCapture
      || resource.recovery || resource.retirement) {
      throw new Error('generated output has unresolved producer or retention authority');
    }
    assertQuietManagedResource(resource);
    assertIdentity(workspace, resource.workspace);
    assertIdentity(output, resource.output);
    const held = database.prepare(`SELECT hold_id FROM workspace_retention_holds
      WHERE released_at IS NULL AND (workspace_path IN (?, ?)
        OR (source_device = ? AND source_inode = ?) OR (source_device = ? AND source_inode = ?)) LIMIT 1`)
      .get(workspace, output, resource.workspace.device, resource.workspace.inode,
        resource.output.device, resource.output.inode);
    const claims = database.prepare(`SELECT operation_id FROM workspace_exact_claims
      WHERE expected_path IN (?, ?) OR source_path IN (?, ?) OR claim_path IN (?, ?)
        OR parent_canonical_path IN (?, ?) OR (parent_device = ? AND parent_inode = ?)
        OR (source_device = ? AND source_inode = ?) OR (claim_device = ? AND claim_inode = ?)
        OR (source_device = ? AND source_inode = ?) OR (claim_device = ? AND claim_inode = ?) LIMIT 1`)
      .get(workspace, output, workspace, output, workspace, output, workspace, output,
        resource.workspace.device, resource.workspace.inode, resource.workspace.device, resource.workspace.inode,
        resource.workspace.device, resource.workspace.inode, resource.output.device, resource.output.inode,
        resource.output.device, resource.output.inode);
    if (held || claims) throw new Error('generated output has an unreleased retention hold or exact claim');
  } finally { database.close(); }
}

try {
  const workspace = realpathSync(process.cwd());
  const output = path.join(workspace, '.next');
  const lock = path.join(output, 'lock');
  // lstat also sees dangling links. No existing lock is stale by inference.
  if (statIfPresent(lock)) throw new Error('existing .next/lock requires separate owner recovery');
  assertNoProducer(workspace);
  if (statIfPresent(output)) assertOwnedOutput(workspace, output);
  // Recheck the lock after the probes. The build wrapper remains the reservation authority.
  if (statIfPresent(lock)) throw new Error('.next/lock appeared during preflight');
  console.log('[preship-cleanup] clear: no lock or unresolved workspace producer');
} catch (error) {
  console.error(`[preship-cleanup] refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
