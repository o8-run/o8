import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thoughtsRoot = fileURLToPath(new URL('../', import.meta.url));
const directPersistencePattern = /\blocalStorage\.(?:getItem|setItem|removeItem)\s*\(|window\.localStorage\b|fetch\(\s*['"]\/api\/panel\/operator-defaults/;

const directPersistenceSeams: Record<string, string> = {
  'chat-panel/composer-queue-recovery.ts': 'Owns versioned uncertain Send next identities and exact payloads per conversation and attempt; recovery never automatically sends work.',
  'chat-panel/composer-draft-store.ts': 'Owns versioned unsent text, completed images and file context per repository and conversation; saving never sends a turn.',
  'chat-panel/transcript-reading-position.ts': 'Owns o8:transcript-reading:v1: reading intent, bounded identities, offsets and order per workspace and thread/session conversation; history deletion removes all matching workspace buckets and invalidates mounted writers before teardown.',
  'composer-mode-storage.ts': 'Owns tab-scoped composer mode persistence and legacy migration.',
  'composer-selector/state.ts': 'Owns selector feature flags plus global and per-thread effort maps.',
  'composer-selector/service-tier-store.ts': 'Owns explicit browser-local speed choices scoped to backend and model, without rewriting CLI settings. Selection still requires current CLI capability validation.',
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

describe('composer selector storage ownership', () => {
  it('keeps direct browser persistence inside explicitly documented seam modules', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(thoughtsRoot)) {
      const relativePath = relative(thoughtsRoot, file);
      const source = readFileSync(file, 'utf8');
      if (directPersistencePattern.test(source) && !directPersistenceSeams[relativePath]) {
        violations.push(relativePath);
      }
    }
    expect(violations).toEqual([]);

    for (const [relativePath, reason] of Object.entries(directPersistenceSeams)) {
      expect(reason.length, `${relativePath} needs an ownership reason`).toBeGreaterThan(0);
      expect(
        readFileSync(join(thoughtsRoot, relativePath), 'utf8'),
        `${relativePath} no longer owns direct persistence and should leave the allowlist`,
      ).toMatch(directPersistencePattern);
    }
  });
});
