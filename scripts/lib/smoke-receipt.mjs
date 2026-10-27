import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SMOKE_STEPS = ['first-window', 'codex-chat', 'claude-chat', 'worker-dispatch', 'cleanup'];
export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function manifestSha256(manifest) {
  return createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex');
}
export function requireSmokeReceipts(manifest, paths) {
  if (!paths.length) throw new Error('smoke receipt required');
  const installers = manifest.installers;
  if (!Array.isArray(installers) || !installers.length) throw new Error('smoke installer identities missing');
  const receipts = paths.map(path => JSON.parse(readFileSync(path, 'utf8')));
  for (const installer of installers) {
    if (!/^[a-f0-9]{64}$/.test(installer.sha256)) throw new Error('smoke installer hash invalid');
    const match = receipts.find(receipt => receipt.schema === 'o8/installed-smoke/v1'
      && receipt.status === 'passed' && receipt.version === manifest.version
      && receipt.artifactSha256 === installer.sha256 && receipt.manifestSha256 === manifestSha256(manifest)
      && SMOKE_STEPS.every(step => receipt.steps?.[step] === 'passed')
      && ['codex', 'claude', 'worker'].every(provider => ['real', 'fixture'].includes(receipt.providers?.[provider])));
    if (!match) throw new Error('smoke receipt missing, failed or mismatched');
  }
}
