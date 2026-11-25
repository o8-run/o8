import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadRedBaseline } from '../scripts/lib/red-baseline.mjs';

const path = 'tests/integration-quarantine.json';
const list = JSON.parse(readFileSync(path, 'utf8')) as {
  count: number;
  files: Array<{ path: string; issue: number; reason: string }>;
};

describe('integration quarantine', () => {
  it('names an existing file, the tracking issue and a one-line reason for every entry', () => {
    expect(list.count).toBe(list.files.length);
    for (const entry of list.files) {
      expect(existsSync(entry.path), entry.path).toBe(true);
      expect(entry.issue).toBe(6761);
      expect(entry.reason.trim().length, entry.path).toBeGreaterThan(10);
      expect(entry.reason, entry.path).not.toContain('\n');
    }
    expect(new Set(list.files.map((entry) => entry.path)).size).toBe(list.files.length);
  });

  it('is readable by the gate as a red list', () => {
    expect(loadRedBaseline(path)?.size).toBe(list.files.length);
  });
});
