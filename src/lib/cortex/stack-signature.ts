/**
 * #748 — Stack signature compute.
 *
 * Reads `package.json` (`dependencies` + `devDependencies`), `Cargo.toml`
 * (`[dependencies]` + `[dev-dependencies]` table keys), and `pyproject.toml`
 * (`[project.dependencies]` + `[tool.poetry.dependencies]` keys) for a
 * single repo and produces a stable `{ deps, hash }` shape. The hash is
 * a sha1 over the sorted dep list, used by callers as a quick equality
 * check before falling back to a Jaccard similarity computation.
 *
 * Cache lives at `~/.o8/stack-signatures.json` — keyed by registered
 * repo id so the cross-repo proposer can resolve signatures without
 * re-reading every manifest on each tick. Recomputed fire-and-forget
 * when the repo registry mutates (add/remove).
 *
 * Toml is parsed by hand. `Cargo.toml` and `pyproject.toml` only need
 * top-level table keys, never values, so a 30-line scanner is enough —
 * pulling in `@iarna/toml` would be cargo-cult and add a dependency.
 *
 * Read-only / synchronous / never throws. Manifest parse failures degrade
 * to "no deps detected" so a single broken file never poisons the boot
 * tick.
 */

import 'server-only';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const SIGNATURE_FILE = 'stack-signatures.json';

export interface StackSignature {
  /** Sorted, deduped union of top-level deps from every manifest in the repo. */
  deps: string[];
  /** sha1(deps.join(',')) — used for fast equality + change-detection. */
  hash: string;
}

interface StoredEntry extends StackSignature {
  repoId: string;
  repoPath: string;
  computedAt: string;
}

interface SignatureStore {
  version: 1;
  signatures: StoredEntry[];
}

// ── manifest parsers ──────────────────────────────────────────────────────

function readJsonSafe(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readPackageDeps(repoPath: string): string[] {
  const parsed = readJsonSafe(join(repoPath, 'package.json'));
  if (!parsed || typeof parsed !== 'object') return [];
  const out: string[] = [];
  const obj = parsed as Record<string, unknown>;
  for (const key of ['dependencies', 'devDependencies']) {
    const block = obj[key];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const name of Object.keys(block as Record<string, unknown>)) {
        if (name) out.push(name);
      }
    }
  }
  return out;
}

/**
 * Read top-level keys from a TOML table. Implemented by a regex scan that
 * jumps to the `[table-name]` header and reads bare keys until the next
 * header. Handles whitespace around `=`, quoted-string keys are skipped
 * (deps in Cargo.toml are always bare identifiers).
 *
 * Returns dep NAMES only — values (versions, paths, features) are
 * intentionally discarded. Two repos with the same `serde` are siblings
 * even if one pins `1.0.193` and the other `1.0.200`.
 */
function readTomlTableKeys(raw: string, tableName: string): string[] {
  const headerRe = new RegExp(
    `^\\[\\s*${tableName.replace(/\./g, '\\.')}\\s*\\]\\s*$`,
    'm',
  );
  const headerMatch = raw.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return [];

  const after = raw.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderIdx = after.search(/^\[/m);
  const block = nextHeaderIdx >= 0 ? after.slice(0, nextHeaderIdx) : after;

  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // `name = ...` or `name.feature = ...` — take everything before the
    // first `=` or `.`.
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const lhs = trimmed.slice(0, eqIdx).trim();
    if (!lhs) continue;
    // Strip dotted-key suffixes: `serde.version = ...` should still record
    // `serde` once. Same for `serde.features`.
    const baseKey = lhs.split('.')[0]?.trim();
    if (!baseKey) continue;
    // Quoted keys would leak quotes; bail out — deps are always bare.
    if (baseKey.startsWith('"') || baseKey.startsWith("'")) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(baseKey)) continue;
    keys.push(baseKey);
  }
  return keys;
}

function readCargoDeps(repoPath: string): string[] {
  const path = join(repoPath, 'Cargo.toml');
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return [
    ...readTomlTableKeys(raw, 'dependencies'),
    ...readTomlTableKeys(raw, 'dev-dependencies'),
  ];
}

function readPyprojectDeps(repoPath: string): string[] {
  const path = join(repoPath, 'pyproject.toml');
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  // Two layouts: PEP-621 `[project.dependencies]` is an inline array, not a
  // table. We pull both Poetry-style table keys and PEP-621 array entries.
  const out: string[] = [];

  // Poetry layout: `[tool.poetry.dependencies]` table with key = value.
  out.push(...readTomlTableKeys(raw, 'tool.poetry.dependencies'));
  out.push(...readTomlTableKeys(raw, 'tool.poetry.dev-dependencies'));

  // PEP-621: `[project] dependencies = ["pkg>=1", "other ; python_version<3.11"]`
  // Match both `dependencies = [ ... ]` and `optional-dependencies.foo = [...]`.
  const projectArrRe = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m;
  // Anchor to the `[project]` table to avoid pulling other tables' arrays.
  const projectIdx = raw.search(/^\[\s*project\s*\]/m);
  if (projectIdx >= 0) {
    const projectScope = raw.slice(projectIdx);
    const nextHdr = projectScope.search(/\n\[/);
    const projectBlock = nextHdr >= 0 ? projectScope.slice(0, nextHdr) : projectScope;
    const arrMatch = projectBlock.match(projectArrRe);
    if (arrMatch) {
      for (const item of arrMatch[1].split(',')) {
        const cleaned = item
          .replace(/[#].*$/g, '')
          .trim()
          .replace(/^['"]|['"]$/g, '');
        if (!cleaned) continue;
        // PEP-508 spec strings: take everything before the first non-name char.
        const nameMatch = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9_\-.]*)/);
        if (nameMatch?.[1]) out.push(nameMatch[1]);
      }
    }
  }

  return out;
}

function normalizeDeps(raw: string[]): string[] {
  const set = new Set<string>();
  for (const name of raw) {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    set.add(trimmed);
  }
  return [...set].sort();
}

function hashDeps(deps: string[]): string {
  return createHash('sha1').update(deps.join(','), 'utf-8').digest('hex').slice(0, 16);
}

// ── public surface ────────────────────────────────────────────────────────

/**
 * Compute the signature for a single repo. Synchronous + no-throw — a missing
 * manifest yields an empty `deps` array, not a rejected promise.
 *
 * Returns `null` only when the path is empty (caller should skip recording).
 */
export function computeSignature(repoPath: string): StackSignature | null {
  if (!repoPath?.trim()) return null;
  const all = [
    ...readPackageDeps(repoPath),
    ...readCargoDeps(repoPath),
    ...readPyprojectDeps(repoPath),
  ];
  const deps = normalizeDeps(all);
  return { deps, hash: hashDeps(deps) };
}

// ── cache (~/.o8/stack-signatures.json) ───────────────────────────────────

function signatureFilePath(): string {
  return join(getDataDir(), SIGNATURE_FILE);
}

export function readSignatureStore(): SignatureStore {
  const path = signatureFilePath();
  if (!existsSync(path)) return { version: 1, signatures: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SignatureStore>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.signatures)) {
      return { version: 1, signatures: [] };
    }
    const signatures = parsed.signatures.filter(
      (e): e is StoredEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.repoId === 'string' &&
        typeof e.repoPath === 'string' &&
        typeof e.hash === 'string' &&
        Array.isArray(e.deps),
    );
    return { version: 1, signatures };
  } catch (err) {
    console.warn('[stack-signature] Failed to parse store:', err instanceof Error ? err.message : err);
    return { version: 1, signatures: [] };
  }
}

function writeSignatureStore(store: SignatureStore): void {
  try {
    writeFileSync(signatureFilePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[stack-signature] Failed to write store:', err instanceof Error ? err.message : err);
  }
}

/** Compute in memory so a cold proposer GET never writes the cache. */
async function computeSignatureStore(): Promise<SignatureStore | null> {
  let entries: RepoRegistryEntry[] = [];
  try {
    entries = await listRepos();
  } catch (err) {
    console.warn('[stack-signature] listRepos failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const now = new Date().toISOString();
  const signatures: StoredEntry[] = [];
  for (const entry of entries) {
    try {
      const sig = computeSignature(entry.localPath);
      if (!sig) continue;
      signatures.push({
        repoId: entry.id,
        repoPath: entry.localPath,
        deps: sig.deps,
        hash: sig.hash,
        computedAt: now,
      });
    } catch (err) {
      console.warn(
        `[stack-signature] compute failed for ${entry.localPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { version: 1, signatures };
}

/** Recompute and persist only from boot and registry mutation maintenance. */
export async function computeAllSignatures(): Promise<SignatureStore> {
  const store = await computeSignatureStore();
  if (!store) return { version: 1, signatures: [] };
  writeSignatureStore(store);
  return store;
}

/**
 * Read the cached store. If the cache is empty or the file doesn't exist,
 * compute in memory inline. Boot and registry mutation hooks persist the
 * cache; the cross-repo proposer still gets fresh-boot data without writing.
 */
export async function readOrComputeSignatures(): Promise<SignatureStore> {
  const existing = readSignatureStore();
  if (existing.signatures.length > 0) return existing;
  return await computeSignatureStore() ?? { version: 1, signatures: [] };
}

// ── boot tick wiring ──────────────────────────────────────────────────────

let bootRan = false;

/**
 * Idempotent boot hook. Mirrors `ensureProposerBootTick` — schedules a
 * one-shot compute + sets `bootRan` so subsequent calls are no-ops. The
 * registry hook handles incremental updates on add/remove; the boot tick
 * just ensures the cache exists for the very first session.
 */
export function ensureStackSignatureBoot(): void {
  if (bootRan) return;
  bootRan = true;
  setImmediate(() => {
    void computeAllSignatures().catch((err) => {
      console.warn('[stack-signature] boot compute threw:', err instanceof Error ? err.message : err);
    });
  });
}

/**
 * Trigger a recompute without waiting on the result. Called from the
 * registry add/remove paths so signatures stay in sync as the user adds
 * repos, without making the registry write block on the recompute.
 */
export function triggerSignatureRecompute(): void {
  setImmediate(() => {
    void computeAllSignatures().catch((err) => {
      console.warn('[stack-signature] recompute threw:', err instanceof Error ? err.message : err);
    });
  });
}
