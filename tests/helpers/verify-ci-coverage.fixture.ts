import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Exercise the real coverage CLI against a small, real classified source tree. */
export function createVerifierCoverageFixture(repo: string, parent: string): string {
  const directory = mkdtempSync(path.join(parent, 'coverage-'));
  for (const file of [
    'scripts/ci/check-verify-ci.mjs', 'scripts/lib/verify-ci.mjs',
    'scripts/lib/test-classification.mjs', 'scripts/lib/browser-prerequisites.mjs',
    '.github/actions/next-linux-setup/action.yml',
    '.github/actions/linux-package-prerequisites/action.yml',
    '.github/workflows/ci.yml', 'package.json',
  ]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    copyFileSync(path.join(repo, file), path.join(directory, file));
  }
  symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  mkdirSync(path.join(directory, 'tests'));
  writeFileSync(path.join(directory, 'tests/browser-fixture.test.ts'),
    "import { chromium } from 'playwright-core';\n");
  writeFileSync(path.join(directory, 'tests/test-classification.json'), JSON.stringify({
    resourceOwning: [{ path: 'tests/browser-fixture.test.ts', browser: true }],
  }));
  return directory;
}
