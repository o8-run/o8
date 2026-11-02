import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { execFileSync, withChildCreationGuard } from '@/lib/providers/child-process';

const root = mkdtempSync(join(getDataDir(), 'child-creation-guard-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function inspect() {
  expect(execFileSync(process.execPath, ['-p', '"inspection complete"'], { encoding: 'utf8' })).toBe('inspection complete\n');
}

function startWorker(receipt: string) {
  return execFileSync(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1], "worker started"); process.stdout.write("started");', receipt,
  ], { encoding: 'utf8' });
}

it('runs an inspection subprocess inside admission before creating each real worker', () => {
  const receipt = join(root, 'admitted');
  const nextReceipt = join(root, 'also-admitted');
  const check = vi.fn(inspect);
  withChildCreationGuard(check, () => {
    expect(startWorker(receipt)).toBe('started');
    expect(startWorker(nextReceipt)).toBe('started');
  });
  expect(check).toHaveBeenCalledTimes(2);
  expect(existsSync(receipt)).toBe(true);
  expect(existsSync(nextReceipt)).toBe(true);
});

it.each(['parent', 'nested'])('keeps the %s refusal before actual worker creation after inspection', refusal => {
  const receipt = join(root, refusal);
  const parent = vi.fn(() => {
    inspect();
    if (refusal === 'parent') throw new Error('parent refused');
  });
  const nested = vi.fn(() => { throw new Error('nested refused'); });
  expect(() => withChildCreationGuard(parent, () => withChildCreationGuard(nested, () => startWorker(receipt))))
    .toThrow(`${refusal} refused`);
  expect(parent).toHaveBeenCalledTimes(1);
  expect(nested).toHaveBeenCalledTimes(refusal === 'nested' ? 1 : 0);
  expect(existsSync(receipt)).toBe(false);
});
