#!/usr/bin/env node
// Usage: node scripts/ci/time-audit.mjs 150 [--json file] [--repo owner/repo]
// --run ID may be repeated to inspect particular cold/warm runs instead.
import { execFile, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export function percentile(values, percent) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)] : null;
}
const seconds = (start, end) => start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : 0;
const install = name => /npm (?:ci|install)|Install (?:root )?dependencies/i.test(name);
const setup = name => install(name) || /setup|set up|checkout|cache|prerequisites|toolchain|Verify native modules/i.test(name);
export function summarizeRun(run, jobs) {
  const active = jobs.filter(job => job.started_at && job.completed_at && job.conclusion !== 'skipped');
  const terminal = active.reduce((last, job) => !last || Date.parse(job.completed_at) > Date.parse(last.completed_at) ? job : last, null);
  return {
    id: run.id, headSha: run.head_sha, attempt: run.run_attempt, event: run.event, conclusion: run.conclusion, url: run.html_url,
    createdAt: run.created_at, completedAt: run.updated_at,
    wallSeconds: seconds(run.created_at, run.updated_at),
    // Actions does not expose a resolved needs DAG. This is the observed path to
    // the last finishing job, including all upstream waiting, not a sum of jobs.
    criticalPath: terminal ? { terminalJob: terminal.name,
      observedSeconds: seconds(run.created_at, terminal.completed_at),
      beforeTerminalSeconds: seconds(run.created_at, terminal.started_at),
      terminalSeconds: seconds(terminal.started_at, terminal.completed_at) } : null,
    jobs: active.map(job => {
      const steps = (job.steps || []).map(step => ({ name: step.name, conclusion: step.conclusion,
        seconds: seconds(step.started_at, step.completed_at), install: install(step.name), setup: setup(step.name) }));
      const setupSeconds = steps.filter(step => step.setup).reduce((sum, step) => sum + step.seconds, 0);
      return { name: job.name, queueSeconds: seconds(job.created_at, job.started_at),
        durationSeconds: seconds(job.started_at, job.completed_at), setupSeconds,
        installSeconds: steps.filter(step => step.install).reduce((sum, step) => sum + step.seconds, 0),
        runningSeconds: steps.filter(step => !step.setup).reduce((sum, step) => sum + step.seconds, 0), steps };
    }),
  };
}
const stats = values => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) });
export function aggregate(runs) {
  const events = {};
  for (const event of [...new Set(runs.map(run => run.event))]) {
    const selected = runs.filter(run => run.event === event);
    const jobs = {};
    for (const name of [...new Set(selected.flatMap(run => run.jobs.map(job => job.name)))].sort()) {
      const samples = selected.flatMap(run => run.jobs.filter(job => job.name === name));
      jobs[name] = Object.fromEntries(['queueSeconds', 'durationSeconds', 'setupSeconds', 'installSeconds', 'runningSeconds'].map(key => [key, stats(samples.map(job => job[key]))]));
      jobs[name].steps = Object.fromEntries([...new Set(samples.flatMap(job => job.steps.map(step => step.name)))].map(name => [name, stats(samples.flatMap(job => job.steps.filter(step => step.name === name).map(step => step.seconds)))]));
    }
    events[event] = { runs: selected.length, window: { first: selected.map(run => run.createdAt).sort()[0], last: selected.map(run => run.createdAt).sort().at(-1) }, conclusions: Object.fromEntries([...new Set(selected.map(run => run.conclusion))].map(value => [value, selected.filter(run => run.conclusion === value).length])),
      wallSeconds: stats(selected.map(run => run.wallSeconds)), criticalPathSeconds: stats(selected.filter(run => run.criticalPath).map(run => run.criticalPath.observedSeconds)), jobs };
  }
  return events;
}
async function main() {
  const args = process.argv.slice(2);
  let combined = false;
  let count = 150, repo = 'o8-run/o8', json;
  const ids = [];
  if (args[0] && !args[0].startsWith('--')) count = Number(args.shift());
  while (args.length) {
    const flag = args.shift();
    if (flag === '--combined') { combined = true; continue; }
    const value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--json') json = value;
    else if (flag === '--repo') repo = value;
    else if (flag === '--run' && /^\d+$/.test(value)) ids.push(value);
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Run count must be a positive integer');
  const gh = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 128 * 1024 ** 2 }));
  const list = [];
  if (ids.length) for (const id of ids) list.push(gh(`repos/${repo}/actions/runs/${id}`));
  else for (const event of combined ? [null] : ['pull_request', 'merge_group', 'push']) {
    for (let page = 1, found = 0; found < count; page++) {
      const batch = gh(`repos/${repo}/actions/workflows/ci.yml/runs?${event ? `event=${event}&` : ''}status=completed&per_page=100&page=${page}`).workflow_runs;
      list.push(...batch.slice(0, count - found)); found += batch.length;
      if (batch.length < 100) break;
    }
  }
  const runs = new Array(list.length);
  let next = 0;
  const request = promisify(execFile);
  // Bounded concurrency keeps a large sample practical without API bursts.
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (next < list.length) {
      const index = next++, run = list[index], jobs = [];
      for (let page = 1; ; page++) {
        const { stdout } = await request('gh', ['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`], { maxBuffer: 128 * 1024 ** 2 });
        const batch = JSON.parse(stdout).jobs;
        jobs.push(...batch); if (batch.length < 100) break;
      }
      runs[index] = summarizeRun(run, jobs);
    }
  }));
  const report = { generatedAt: new Date().toISOString(), method: `${combined ? 'Last N completed runs combined' : 'Last N completed runs per event'}, all conclusions; nearest-rank percentiles in seconds. Queue = job creation to start (may include dependency waiting). Critical path = observed run creation to last job completion; resolved needs DAG unavailable. Install includes npm version setup; nested composite steps appear as one setup step.`, events: aggregate(runs), runs };
  if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(report.method);
  for (const [event, summary] of Object.entries(report.events)) {
    console.log(`\n${event}: ${summary.runs} runs; wall p50=${summary.wallSeconds.p50}s p95=${summary.wallSeconds.p95}s; critical path p50=${summary.criticalPathSeconds.p50}s p95=${summary.criticalPathSeconds.p95}s`);
    console.log('job | queue p50/p95 | duration p50/p95 | setup p50/p95 | install p50/p95 | running p50/p95 (seconds)');
    for (const [name, job] of Object.entries(summary.jobs)) {
      console.log(`${name} | ${['queueSeconds', 'durationSeconds', 'setupSeconds', 'installSeconds', 'runningSeconds'].map(key => `${job[key].p50}/${job[key].p95}`).join(' | ')}`);
      for (const [name, step] of Object.entries(job.steps).filter(([name]) => setup(name))) console.log(`  ${name}: ${step.p50}/${step.p95} (n=${step.n})`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
