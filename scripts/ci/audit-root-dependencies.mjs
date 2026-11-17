#!/usr/bin/env node
// Root dependency audit for CI and verify:ci. It fails on every high or
// critical finding, except a finding caused only by advisories listed in
// npm-audit-exceptions.json. An entry needs a reason and an expiry date, and
// the audit fails when an entry has expired or its advisory no longer appears,
// so the list cannot outlive the problem it records.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);
const listPath = process.env.NPM_AUDIT_EXCEPTIONS
  || join(dirname(fileURLToPath(import.meta.url)), 'npm-audit-exceptions.json');

function fail(lines) {
  for (const line of [lines].flat()) console.error(`npm audit: ${line}`);
  process.exit(1);
}

let entries;
try { entries = JSON.parse(readFileSync(listPath, 'utf8')); } catch (error) { fail(`cannot read the exception list: ${error.message}`); }
if (!Array.isArray(entries) || entries.some(entry => !entry || !/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.id)
  || typeof entry.package !== 'string' || !entry.package || typeof entry.reason !== 'string' || !entry.reason
  || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(Date.parse(entry.expires)))) {
  fail('every exception needs id (GHSA), package, reason and expires (YYYY-MM-DD)');
}
const label = entry => `${entry.id} (${entry.package})`;

const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// npm exits 1 when it has findings. Anything else is a failed run, not a clean one.
if (run.error || (run.status !== 0 && run.status !== 1)) fail(`npm audit did not run (${run.error?.message ?? `exit ${run.status}`})`);
let report;
try { report = JSON.parse(run.stdout); } catch { fail('npm audit printed no readable report'); }
const findings = report?.vulnerabilities;
if (report?.error || report?.auditReportVersion !== 2 || !findings || typeof findings !== 'object') fail('npm audit returned no usable report');

// A finding names its advisories directly, or names the dependency it inherits them from.
function advisories(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const finding = findings[name];
  if (!finding || !Array.isArray(finding.via)) fail(`finding "${name}" cannot be resolved`);
  return finding.via.flatMap(via => {
    if (typeof via === 'string') return advisories(via, seen);
    const id = /GHSA(-[23456789cfghjmpqrvwx]{4}){3}/.exec(String(via?.url ?? ''))?.[0];
    if (!id || typeof via.severity !== 'string') fail(`finding "${name}" has an advisory without an id or severity`);
    return [{ id, severity: via.severity }];
  });
}

const excepted = new Set(entries.map(entry => entry.id));
const seenIds = new Set();
const blocking = [];
let exceptedFindings = 0;
for (const [name, finding] of Object.entries(findings)) {
  const found = advisories(name);
  for (const advisory of found) seenIds.add(advisory.id);
  const serious = found.filter(advisory => BLOCKING.has(advisory.severity));
  if (BLOCKING.has(finding.severity) && serious.length === 0) fail(`finding "${name}" is ${finding.severity} with no advisory to judge`);
  const unlisted = [...new Set(serious.filter(advisory => !excepted.has(advisory.id)).map(advisory => advisory.id))];
  if (unlisted.length) blocking.push(`${name}: ${unlisted.join(', ')}`);
  else if (serious.length) exceptedFindings++;
}

const today = new Date().toISOString().slice(0, 10);
const problems = [
  ...blocking.map(line => `blocking finding ${line}`),
  ...entries.filter(entry => entry.expires < today).map(entry => `${label(entry)} expired on ${entry.expires}; fix it or renew the entry with a reason`),
  ...entries.filter(entry => !seenIds.has(entry.id)).map(entry => `${label(entry)} no longer appears; remove this entry`),
];
if (problems.length) fail(problems);
console.log(`npm audit passed: 0 blocking high/critical findings; ${exceptedFindings} findings covered by ${entries.length} dated exception(s)`);
