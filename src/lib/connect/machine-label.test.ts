import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultMachineLabel, normalizeMachineLabel, saveMachineLabel } from './machine-label';

describe('account machine label', () => {
  it('defaults to a generic name for the platform', () => {
    expect(defaultMachineLabel('darwin')).toBe('Mac');
    expect(defaultMachineLabel('win32')).toBe('Windows PC');
    expect(defaultMachineLabel('linux')).toBe('Linux computer');
    expect(defaultMachineLabel('freebsd')).toBe('Computer');
  });

  it('keeps one trimmed line of at most 80 characters without control characters', () => {
    expect(normalizeMachineLabel('  Studio  ')).toBe('Studio');
    expect(normalizeMachineLabel('Studio\nsecond line')).toBe('Studio');
    expect(normalizeMachineLabel('Stu\u0007dio')).toBe('Studio');
    expect(normalizeMachineLabel('x'.repeat(120))).toHaveLength(80);
    expect(normalizeMachineLabel('   ')).toBeNull();
    expect(normalizeMachineLabel(42)).toBeNull();
  });

  it('saves the label where paired phones read it', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'o8-machine-label-'));
    try {
      saveMachineLabel('Studio', dataDir);
      expect(readFileSync(path.join(dataDir, 'computer-name'), 'utf8')).toBe('Studio\n');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
