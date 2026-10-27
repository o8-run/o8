import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

try {
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const policy = JSON.parse(readFileSync(process.argv[3] ?? 'scripts/ci/security-allowlist.json', 'utf8'));
  if (!Array.isArray(report) || !Array.isArray(policy.gitleaks)) throw new Error();
  const today = new Date().toISOString().slice(0, 10);
  const root = realpathSync('.');
  const validPath = file => typeof file === 'string' && file.length > 0
    && !isAbsolute(file) && !file.split(/[\\/]/).includes('..');
  const validSpan = (start, end) => Number.isSafeInteger(start) && start > 0
    && Number.isSafeInteger(end) && end >= start;
  for (const entry of policy.gitleaks) {
    if (!validPath(entry.file) || !validSpan(entry.startLine, entry.endLine)
      || typeof entry.rule !== 'string' || !entry.rule
      || !/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? '')
      || typeof entry.reason !== 'string' || !entry.reason.trim() || /[\r\n]/.test(entry.reason)
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy ?? '')
      || !Number.isFinite(Date.parse(entry.reviewBy))) throw new Error();
  }
  let accepted = 0;
  for (const finding of report) {
    if (!finding || !validPath(finding.File) || !validSpan(finding.StartLine, finding.EndLine)
      || typeof finding.RuleID !== 'string' || !finding.RuleID) throw new Error();
    const sourcePath = realpathSync(resolve(root, finding.File));
    const fromRoot = relative(root, sourcePath);
    if (!validPath(fromRoot)) throw new Error();
    const lines = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    if (finding.EndLine > lines.length) throw new Error();
    const digest = createHash('sha256')
      .update(lines.slice(finding.StartLine - 1, finding.EndLine).join('\n')).digest('hex');
    if (policy.gitleaks.some(entry => entry.file === finding.File
      && entry.startLine === finding.StartLine && entry.endLine === finding.EndLine
      && entry.rule === finding.RuleID && entry.sourceSha256 === digest && entry.reviewBy >= today)) accepted++;
  }
  const pending = report.length - accepted;
  // Never echo source, match text or scanner-provided credential fields.
  console.log(`Secret matches: ${report.length}; accepted: ${accepted}; require review: ${pending}`);
  process.exitCode = pending ? 1 : 0;
} catch {
  console.error('Secret scanner evidence unavailable or invalid');
  process.exitCode = 2;
}
