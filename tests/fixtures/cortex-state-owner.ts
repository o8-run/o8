import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordTiming } from '../../src/lib/cortex/diagnostics';
import { startCortexDiagnosticsPublisher } from '../../src/lib/cortex/diagnostics-state';
import { readProcessCwdsForPids } from '../../src/lib/runtime/process-cwd-snapshot';

async function run() {
  if (process.argv[2] === '--timings-only') {
    for (let index = 0; index < 25; index++) {
      recordTiming({ label: `fixture.producer.${process.argv[3]}`, durationMs: index, timestamp: Date.now() });
    }
    return;
  }
  startCortexDiagnosticsPublisher();
  await readProcessCwdsForPids([]);
  recordTiming({ label: 'fixture.owner.process', durationMs: 43, timestamp: Date.now() });
  const directory = process.env.CORTEX_IDE_DATA_DIR!;
  writeFileSync(join(directory, 'owner-result.json'), '{}');
  // Stay alive as the live owner until the test releases it.
  const timer = setInterval(() => { if (existsSync(join(directory, 'finish-owner'))) clearInterval(timer); }, 20);
}

void run().catch(() => { process.exitCode = 1; });
