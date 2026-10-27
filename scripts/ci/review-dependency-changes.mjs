#!/usr/bin/env node
// CI and local verification audit the same added lockfile versions. Existing
// findings belong to the full audits, not the dependency-change gate.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

function git(args, optional = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    if (optional && result.status === 128) return null;
    throw new Error('dependency comparison history is unavailable; fetch origin/main and the branch history');
  }
  return result.stdout;
}
function npmPackages(lock) {
  if (!lock.packages || lock.lockfileVersion < 2) throw new Error('dependency audit requires a modern package lock');
  return new Map(Object.entries(lock.packages).filter(([location, item]) => location && item.version && !item.link)
    .map(([location, item]) => [location, { name: item.name ?? location.split('node_modules/').at(-1), version: item.version }]));
}
function identity(item) { return `${item.name}@${item.version}`; }
function audit(tool, args, directory) {
  const result = spawnSync(tool, args, { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`${tool} dependency audit could not complete`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error(`${tool} dependency audit returned invalid data`); }
  if (report.error) throw new Error(`${tool} dependency audit returned an error`);
  return report;
}

let temporary;
try {
  const [base = 'origin/main', head = '--worktree', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('usage: review-dependency-changes.mjs [base-ref] [head-ref|--worktree]');
  const threshold = process.env.DEPENDENCY_REVIEW_FAIL_ON_SEVERITY ?? 'low';
  if (threshold !== 'low') throw new Error('dependency review requires the CI low severity threshold');
  const workingTree = head === '--worktree';
  const mergeBase = git(['merge-base', base || 'origin/main', workingTree ? 'HEAD' : head]).trim();
  const changed = git(['diff', '--name-only', '-z', mergeBase, ...(workingTree ? [] : [head])]).split('\0').filter(Boolean);
  if (workingTree) changed.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  const locks = [...new Set(changed.filter(file => /(?:^|\/)(?:package-lock\.json|Cargo\.lock)$/.test(file)))];
  const baselineFiles = new Set(git(['ls-tree', '-r', '--name-only', base || 'origin/main']).trim().split('\n'));
  temporary = mkdtempSync(path.join(tmpdir(), 'o8-dependency-audit-'));
  let failures = 0;
  for (const file of locks) {
    const current = workingTree ? (existsSync(file) ? readFileSync(file, 'utf8') : null) : git(['show', `${head}:${file}`], true);
    if (current === null) continue;
    const previous = baselineFiles.has(file) ? git(['show', `${base || 'origin/main'}:${file}`]) : null;
    const directory = path.join(temporary, String(locks.indexOf(file)));
    mkdirSync(directory);
    if (file.endsWith('package-lock.json')) {
      const lock = JSON.parse(current);
      const packages = npmPackages(lock);
      const baseline = new Set(previous ? [...npmPackages(JSON.parse(previous)).values()].map(identity) : []);
      const added = new Set([...packages.values()].map(identity).filter(key => !baseline.has(key)));
      if (!added.size) continue;
      writeFileSync(path.join(directory, 'package-lock.json'), current);
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'dependency-audit', version: '1.0.0', ...lock.packages[''] }));
      const report = audit('npm', ['audit', '--package-lock-only', '--ignore-scripts', '--json', `--audit-level=${threshold}`], directory);
      if (report.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== 'object'
        || Array.isArray(report.vulnerabilities)) {
        throw new Error('npm dependency audit response is incomplete');
      }
      for (const finding of Object.values(report.vulnerabilities)) {
        if (!finding || !Array.isArray(finding.nodes) || !finding.nodes.length
          || finding.nodes.some(location => typeof location !== 'string' || !packages.has(location))
          || !['info', 'low', 'moderate', 'high', 'critical'].includes(finding.severity)) {
          throw new Error('npm dependency audit finding is incomplete');
        }
        for (const location of finding.nodes) {
          const item = packages.get(location);
          if (finding.severity === 'info' || !added.has(identity(item))) continue;
          console.error(`${file}: ${identity(item)}: ${finding.severity} vulnerability added`);
          failures++;
        }
      }
    } else {
      const packages = parseToml(current).package;
      const baseline = new Set(previous ? (parseToml(previous).package ?? []).map(identity) : []);
      if (!Array.isArray(packages)) throw new Error('native dependency lock is incomplete');
      const added = new Set(packages.map(identity).filter(key => !baseline.has(key)));
      if (!added.size) continue;
      const lockfile = path.join(directory, 'Cargo.lock');
      writeFileSync(lockfile, current);
      const report = audit('cargo-audit', ['audit', '--json', '--file', lockfile], directory);
      if (!Array.isArray(report.vulnerabilities?.list)) throw new Error('native dependency audit response is incomplete');
      for (const finding of report.vulnerabilities.list) {
        if (!finding.package?.name || !finding.package.version) throw new Error('native dependency audit finding is incomplete');
        if (!added.has(identity(finding.package))) continue;
        console.error(`${file}: ${identity(finding.package)}: vulnerability added`);
        failures++;
      }
    }
  }
  console.log(`dependency review ${failures ? 'failed' : 'passed'}: ${failures} vulnerable added versions (threshold: ${threshold})`);
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  console.error(`[dependency-review] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
