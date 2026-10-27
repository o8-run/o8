import { readFileSync } from 'node:fs';

try {
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const policy = JSON.parse(readFileSync(process.argv[3] ?? 'scripts/ci/security-allowlist.json', 'utf8'));
  if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== 'object'
    || Array.isArray(report.vulnerabilities) || !Array.isArray(policy.accepted)) {
    throw new Error('Incomplete scanner report or policy');
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of policy.accepted) {
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.id ?? '')
      || typeof entry.package !== 'string' || !entry.package || !entry.reason?.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy ?? '')
      || !Number.isFinite(Date.parse(entry.reviewBy))) throw new Error('Invalid accepted finding');
  }
  const findings = new Map();
  for (const value of Object.values(report.vulnerabilities)) {
    if (!Array.isArray(value.via) || value.via.length === 0) throw new Error('Missing advisory detail');
    for (const advisory of value.via) {
      if (typeof advisory === 'string') {
        if (!report.vulnerabilities[advisory]) throw new Error('Missing dependency advisory');
        continue;
      }
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(advisory?.url ?? '')?.[1];
      if (!id || typeof advisory.name !== 'string') throw new Error('Missing advisory identity');
      findings.set(`${advisory.name}:${id}`, { id, package: advisory.name });
    }
  }
  function hasEvidence(name, visiting = new Set()) {
    if (visiting.has(name)) return false;
    const next = new Set(visiting).add(name);
    return report.vulnerabilities[name].via.some(advisory => typeof advisory !== 'string'
      || hasEvidence(advisory, next));
  }
  if (!Object.keys(report.vulnerabilities).every(name => hasEvidence(name))) {
    throw new Error('Missing concrete advisory evidence');
  }
  let pending = 0;
  for (const finding of findings.values()) {
    const accepted = policy.accepted.some(entry => entry.id === finding.id
      && entry.package === finding.package && entry.reviewBy >= today);
    if (!accepted) pending++;
    console.log(`${accepted ? 'accepted' : 'review'} ${finding.id} ${finding.package}`);
  }
  console.log(`Advisories: ${findings.size}; require review: ${pending}`);
  process.exitCode = pending ? 1 : 0;
} catch (error) {
  console.error(`Scanner evidence unavailable: ${error.message}`);
  process.exitCode = 2;
}
