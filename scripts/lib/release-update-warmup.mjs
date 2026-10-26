import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { releaseBuildProfile } from './release-build-profile.mjs';

function positive(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error('Update publication timing must be a bounded positive integer.');
  }
  return number;
}

function persist(receiptPath, receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, receiptPath);
}

/** Observe the normal configured URLs, so a receipt proves installed clients can see the offer. */
export async function warmUpdatePublication({ root, version, previousVersion, publishedAt,
  receiptPath, retryMs, timeoutMs }) {
  if (![version, previousVersion].every(value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) {
    throw new Error('Update publication requires stable release and previous versions.');
  }
  const publication = Date.parse(publishedAt);
  if (!Number.isFinite(publication) || publication > Date.now()) throw new Error('Update publication time is invalid.');
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const endpoints = config?.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 2 || !endpoints.every(value => typeof value === 'string')) {
    throw new Error('Update publication requires both configured update endpoints.');
  }
  const budget = positive(timeoutMs, 240_000, 240_000);
  const retry = positive(retryMs, 5_000, 30_000);
  const probes = endpoints.flatMap((endpoint, index) => ['aarch64', 'x86_64'].map(arch => {
    const url = new URL(endpoint.replaceAll('{{target}}', 'darwin').replaceAll('{{arch}}', arch)
      .replaceAll('{{current_version}}', previousVersion));
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
      throw new Error('Update publication endpoint must use a secure transport.');
    }
    return { source: index === 0 ? 'primary' : 'fallback', target: 'darwin', arch, url };
  }));
  receiptPath ??= join(releaseBuildProfile(root, process.env, { release: true }).profile,
    'update-publication', `v${version}.json`);
  const receipt = { schema: 'o8/update-publication-receipt/v1', version, previousVersion, publishedAt,
    startedAt: new Date().toISOString(), status: 'pending', attempts: 0, checks: [], publishToOfferMs: null,
    publishToOfferBudgetMs: 300_000, withinPublishToOfferBudget: null };
  persist(receiptPath, receipt);
  const deadline = performance.now() + budget;
  do {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    receipt.checks = await Promise.all(probes.map(async ({ url, ...probe }) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(2_000, remaining)) });
        const manifest = response.status === 200 ? await response.json() : null;
        if (response.status !== 200) await response.body?.cancel();
        return { ...probe, status: response.status, version: typeof manifest?.version === 'string' ? manifest.version : null,
          checkedAt: new Date().toISOString() };
      } catch {
        return { ...probe, status: null, version: null, checkedAt: new Date().toISOString(), errorCode: 'request_failed' };
      }
    }));
    receipt.attempts += 1;
    if (receipt.checks.every(check => check.status === 200 && check.version === version)) {
      receipt.status = 'offered';
      receipt.publishToOfferMs = Date.now() - publication;
      receipt.withinPublishToOfferBudget = receipt.publishToOfferMs < receipt.publishToOfferBudgetMs;
    }
    persist(receiptPath, receipt);
    if (receipt.status === 'offered' || performance.now() >= deadline) return receipt;
    await new Promise(resolve => setTimeout(resolve, Math.min(retry, Math.max(1, deadline - performance.now()))));
  } while (performance.now() < deadline);
  return receipt;
}
