#!/usr/bin/env node
import { readFileSync } from 'node:fs';

class MetricsError extends Error {}
const EVENTS = new Set([
  'app.opened', 'brain.asked', 'orchestrator.message', 'dispatch.started',
  'merge.approved', 'repo.added', 'worker.first_launched', 'merge.first_completed', 'session.ended',
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const invalidExport = () => new MetricsError('Invalid metrics export; expected versioned anonymous events.');

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') return { help: true };
    if (!['--date', '--fixture'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new MetricsError('Usage: npm run metrics:daily -- [--date YYYY-MM-DD] [--fixture FILE]');
    }
    const key = flag.slice(2);
    if (result[key] !== undefined) throw new MetricsError('Each report option may be supplied only once.');
    result[key] = args[++index];
  }
  result.date ??= new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const start = Date.parse(`${result.date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date) || !Number.isFinite(start)
    || new Date(start).toISOString().slice(0, 10) !== result.date) {
    throw new MetricsError('Report date must be a valid UTC date in YYYY-MM-DD form.');
  }
  return { ...result, start, end: start + DAY_MS };
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
const opaqueId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function normalizeExport(data, end) {
  const through = timestamp(data?.completeThrough);
  if (data?.schemaVersion !== 1 || data.historyComplete !== true || through === null || through < end
    || !Array.isArray(data.events)) {
    throw new MetricsError('Metrics export must contain complete history through the end of the requested UTC day.');
  }
  const unique = new Map();
  for (const event of data.events) {
    const time = timestamp(event?.timestamp);
    if (!opaqueId(event?.id) || !opaqueId(event?.installId) || time === null
      || typeof event.appVersion !== 'string' || event.appVersion.length > 80
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(event.appVersion)
      || !EVENTS.has(event.event) || (event.event === 'session.ended' && typeof event.props?.clean !== 'boolean')) {
      throw invalidExport();
    }
    const row = {
      id: event.id, installId: event.installId, appVersion: event.appVersion,
      time, event: event.event, clean: event.event === 'session.ended' ? event.props.clean : null,
    };
    if (unique.has(row.id) && JSON.stringify(unique.get(row.id)) !== JSON.stringify(row)) {
      throw new MetricsError('Conflicting event identifiers in metrics export.');
    }
    unique.set(row.id, row);
  }
  return [...unique.values()].sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
}

async function readExport(config) {
  if (config.fixture) {
    try { return JSON.parse(readFileSync(config.fixture, 'utf8')); }
    catch { throw new MetricsError('Metrics fixture could not be read as JSON.'); }
  }
  const endpoint = process.env.O8_METRICS_READ_URL?.trim();
  const credential = process.env.O8_METRICS_READ_TOKEN?.trim();
  if (!endpoint || !credential) {
    throw new MetricsError('Live metrics need O8_METRICS_READ_URL and O8_METRICS_READ_TOKEN. No telemetry read endpoint is implemented in this repository.');
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new MetricsError('Invalid metrics read URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new MetricsError('Metrics read URL must use HTTPS without embedded credentials, query, or fragment.');
  }
  try {
    const response = await fetch(url, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new MetricsError(`Metrics read failed (HTTP ${response.status}).`);
    try { return await response.json(); } catch { throw new MetricsError('Metrics read failed: invalid JSON export.'); }
  } catch (error) {
    // Never echo an upstream body, URL, exception, headers, or credentials.
    throw error instanceof MetricsError ? error : new MetricsError('Metrics read failed.');
  }
}

function aggregate(events, config) {
  const firstSeen = new Map();
  const firstWorker = new Map();
  const firstMerge = new Map();
  for (const event of events) {
    if (!firstSeen.has(event.installId)) firstSeen.set(event.installId, event);
    if (event.event === 'worker.first_launched' && !firstWorker.has(event.installId)) firstWorker.set(event.installId, event);
    if (event.event === 'merge.first_completed' && !firstMerge.has(event.installId)) firstMerge.set(event.installId, event);
  }
  const versions = new Map();
  for (const event of events) {
    if (event.time < config.start || event.time >= config.end) continue;
    if (!versions.has(event.appVersion)) versions.set(event.appVersion, {
      installs: new Set(), active: new Set(), workers: new Set(), merges: new Set(), clean: 0, ended: 0,
    });
    const row = versions.get(event.appVersion);
    row.active.add(event.installId);
    if (firstSeen.get(event.installId) === event) row.installs.add(event.installId);
    if (firstWorker.get(event.installId) === event) row.workers.add(event.installId);
    if (firstMerge.get(event.installId) === event) row.merges.add(event.installId);
    if (event.event === 'session.ended') { row.ended += 1; row.clean += Number(event.clean); }
  }
  return versions;
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log('Usage: npm run metrics:daily -- [--date YYYY-MM-DD] [--fixture FILE]\nDefaults to the previous complete UTC day. Live reads require O8_METRICS_READ_URL and O8_METRICS_READ_TOKEN in the environment.');
    return;
  }
  const events = normalizeExport(await readExport(config), config.end);
  const versions = aggregate(events, config);
  console.log(`Usage metrics for ${config.date} (UTC)`);
  if (config.fixture) console.log('Fixture data; these are not production numbers.');
  console.log('| App version | New installs | Daily active installs | First worker launched | First merge | Clean-session rate |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const version of [...versions.keys()].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))) {
    const row = versions.get(version);
    const rate = row.ended ? `${(100 * row.clean / row.ended).toFixed(1)}% (${row.clean}/${row.ended})` : '—';
    console.log(`| ${version} | ${row.installs.size} | ${row.active.size} | ${row.workers.size} | ${row.merges.size} | ${rate} |`);
  }
  if (!versions.size) console.log('No observed usage for this date.');
}

main().catch((error) => {
  console.error(error instanceof MetricsError ? error.message : 'Daily metrics failed.');
  process.exitCode = 1;
});
