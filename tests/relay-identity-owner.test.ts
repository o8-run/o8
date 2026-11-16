import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ownsDataDirRelayIdentity } from '@/lib/panel/api-port';

describe('relay identity ownership', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'o8-relay-owner-'));
    previous = process.env.O8_DATA_DIR;
    process.env.O8_DATA_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.O8_DATA_DIR;
    else process.env.O8_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets the only server in a data folder use the relay', () => {
    expect(ownsDataDirRelayIdentity(47105)).toBe(true);
  });

  it('lets the server the data folder names use the relay', () => {
    writeFileSync(join(dir, 'ws-port'), '47105\n');
    expect(ownsDataDirRelayIdentity(47105)).toBe(true);
  });

  it('keeps a second server on another port off the relay', () => {
    writeFileSync(join(dir, 'ws-port'), '47105\n');
    expect(ownsDataDirRelayIdentity(47125)).toBe(false);
  });
});
