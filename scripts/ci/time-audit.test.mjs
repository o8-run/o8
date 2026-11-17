import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, summarizeRun } from './time-audit.mjs';
test('nearest-rank percentiles and observed critical path do not sum parallel jobs', () => {
  assert.equal(percentile([40, 10, 30, 20], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.equal(percentile([], 50), null);
  const at = seconds => new Date(seconds * 1000).toISOString();
  const run = summarizeRun({ id: 1, event: 'pull_request', created_at: at(0), updated_at: at(120) }, [
    { name: 'parallel', created_at: at(2), started_at: at(5), completed_at: at(70), steps: [] },
    { name: 'terminal', created_at: at(3), started_at: at(6), completed_at: at(100), steps: [
      { name: 'Run npm ci --prefer-offline', started_at: at(6), completed_at: at(26), conclusion: 'success' },
      { name: 'Test', started_at: at(26), completed_at: at(100), conclusion: 'success' },
    ] },
  ]);
  assert.equal(run.wallSeconds, 120);
  assert.equal(run.criticalPath.observedSeconds, 100);
  assert.equal(run.criticalPath.terminalJob, 'terminal');
  assert.equal(run.jobs[1].queueSeconds, 3);
  assert.equal(run.jobs[1].installSeconds, 20);
  assert.equal(run.jobs[1].runningSeconds, 74);
});
