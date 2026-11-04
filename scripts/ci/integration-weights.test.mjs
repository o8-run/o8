import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./integration-weights.mjs', import.meta.url));

for (const source of ['arguments', 'stdin']) {
  test(`harvests PASS and FAIL durations from ${source}, replacing measurements and retaining unseen files`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'o8-integration-weights-'));
    try {
      mkdirSync(join(directory, 'tests'));
      const weightsPath = join(directory, 'tests/integration-weights.json');
      writeFileSync(weightsPath, JSON.stringify({ 'tests/z.test.ts': 9, 'tests/a.test.ts': 50 }));
      const logs = [
        '2026-11-01T05:00:00Z [integration-gate] 1/3 PASS tests/a.test.ts · 2/2 passed · 1.2s\n'
          + '[integration-gate] 2/3 FAIL tests/b.test.ts · 0/1 passed · 0.0s · fixture failure\n',
        '[integration-gate] 3/3 PASS tests/a.test.ts · 2/2 passed · 3.1s\r\n'
          + '[integration-gate] 3/3 tests/ignored.test.ts heartbeat (60s)\n'
          + '[integration-gate] summary: 3/3 files, 4/5 tests passed\n',
      ];
      const paths = logs.map((log, index) => {
        const path = join(directory, `shard-${index}.log`);
        writeFileSync(path, log);
        return path;
      });
      const result = spawnSync(process.execPath, [script, ...(source === 'arguments' ? paths : [])], {
        cwd: directory, encoding: 'utf8', input: source === 'stdin' ? logs.join('') : undefined,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /updated 2 files/);
      assert.equal(readFileSync(weightsPath, 'utf8'), `${JSON.stringify({
        'tests/a.test.ts': 4, 'tests/b.test.ts': 1, 'tests/z.test.ts': 9,
      }, null, 2)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
