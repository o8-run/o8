import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { requirePiNode } from '@/lib/pi/sdk/platform';
import { claimSymonBrainStore } from '@/lib/symon/durable/store-owner';
import { brainRefusalBlocksReceiver } from '@/lib/symon/messages-receiver/owner';

const root = mkdtempSync(join(tmpdir(), 'o8-receiver-brain-gate-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function refusal(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('Messages receiver start after a brain failure', () => {
  it('stays stopped while another owner holds the brain store', () => {
    const storagePath = join(root, 'durable.sqlite');
    const release = claimSymonBrainStore(storagePath);
    try {
      expect(brainRefusalBlocksReceiver(refusal(() => claimSymonBrainStore(storagePath)()))).toBe(true);
    } finally {
      release();
    }
  });

  it('still starts when the brain cannot open on this Node release', () => {
    expect(brainRefusalBlocksReceiver(refusal(() => requirePiNode('22.18.0')))).toBe(false);
    expect(brainRefusalBlocksReceiver('unavailable')).toBe(false);
  });
});
