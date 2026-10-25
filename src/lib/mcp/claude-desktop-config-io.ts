import { withMcpConfigPolicy } from '@/lib/providers/mcp-config-policy';
/**
 * Claude Desktop / Claude Code config file I/O — tolerant read + atomic,
 * backup-preserving write.
 *
 * Extracted from `app/api/setup/claude-desktop/route.ts` (Step D) so the merge
 * write — including the `.o8-backup-<ts>` side file — is unit-testable. The
 * route still owns WHEN to write and WHAT to merge (via the Tool-Spine
 * `toClaudeDesktopJson` projection); this owns HOW the bytes hit disk. Behavior
 * is preserved verbatim: tolerant JSON parse, timestamped backup of the prior
 * file, `JSON.stringify(config, null, 2) + '\n'` (trailing newline), tmp+rename.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClaudeDesktopConfig } from '@/lib/mcp/tool-spine/emit-claude-desktop';

export type { ClaudeDesktopConfig };

export function readClaudeConfig(path: string): ClaudeDesktopConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as ClaudeDesktopConfig;
  } catch {
    // Malformed — return empty so the caller can decide whether to bail or
    // overwrite with a fresh file.
    return {};
  }
}

export function atomicWriteConfig(path: string, config: ClaudeDesktopConfig, runtimeId = 'claude-code'): void {
  withMcpConfigPolicy(config, runtimeId, () => writeConfig(path, config));
}

function writeConfig(path: string, config: ClaudeDesktopConfig): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Back up the existing file before overwriting. The backup name carries a
  // timestamp — callers/tests must not byte-compare the NAME, only its content.
  if (existsSync(path)) {
    const backupPath = `${path}.o8-backup-${Date.now()}`;
    try {
      copyFileSync(path, backupPath);
    } catch {
      // Don't block the write on a failed backup.
    }
  }

  const tmpPath = `${path}.o8-tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
}
