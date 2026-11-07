import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureCodebaseMemoryBootIndex, getIndexState } from '../../src/lib/codebase-memory/indexer';
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
  ensureCodebaseMemoryBootIndex();
  ensureCodebaseMemoryBootIndex();
  const timer = setInterval(() => {
    const state = getIndexState();
    if (!state.entries.some(entry => entry.status === 'ready')) return;
    writeFileSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'owner-result.json'), JSON.stringify(state));
    clearInterval(timer);
  }, 20);
}

void run().catch(() => { process.exitCode = 1; });
