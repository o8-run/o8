import fs from 'node:fs';
import path from 'node:path';

const round = value => Math.round(value * 100) / 100;

function normalized(value) {
  if (value.includes('data:') || value.startsWith('blob:')) return '<generated>';
  const marker = '/Contents/Resources/server/';
  const index = value.indexOf(marker);
  return (index >= 0 ? '<bundle>/' + value.slice(index + marker.length)
    : value.replace(/\/Users\/[^/]+/g, '<runner>').replace(/\/private\/(?:tmp|var)\/[^:]+/g, '<profile>')).slice(0, 300);
}

export async function collectLaunchStageProfile(dataDir, startedEpochMs, { roles = ['http', 'realtime'] } = {}) {
  const directory = path.join(dataDir, 'launch-profile');
  fs.writeFileSync(path.join(directory, 'stop'), '1');
  const deadline = Date.now() + 20_000;
  let files;
  for (;;) {
    files = fs.readdirSync(directory).filter(file => file.endsWith('.timing.json'));
    const snapshots = files.map(file => ({ file, data: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) }));
    const ready = roles.every(role => snapshots.some(row => row.data.role === role && row.data.listeners.length > 0))
      && snapshots.every(row => !row.data.profiled || fs.existsSync(path.join(directory, row.file.replace('.timing.json', '.cpuprofile'))));
    if (ready) break;
    if (Date.now() >= deadline) throw new Error('Launch observers did not flush complete listener and CPU snapshots for: ' + roles.join(', '));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return files.map(file => {
    const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const cpuFile = path.join(directory, file.replace('.timing.json', '.cpuprofile'));
    let cpu = [];
    if (fs.existsSync(cpuFile)) {
      const profile = JSON.parse(fs.readFileSync(cpuFile, 'utf8'));
      const nodes = new Map(profile.nodes.map(node => [node.id, node]));
      const samples = new Map();
      for (let index = 0; index < (profile.samples || []).length; index++) {
        const id = profile.samples[index];
        samples.set(id, (samples.get(id) || 0) + (profile.timeDeltas[index] || 0));
      }
      cpu = [...samples].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id, microseconds]) => ({
        function: (nodes.get(id)?.callFrame.functionName || '<anonymous>').slice(0, 120),
        source: normalized(nodes.get(id)?.callFrame.url || ''), sampledMs: round(microseconds / 1000),
      }));
    }
    return { role: data.role, entryMs: round(data.timeOrigin - startedEpochMs),
      listeners: data.listeners.map(row => ({ atMs: round(row.epochMs - startedEpochMs) })),
      requests: data.requests.map(row => ({ route: row.route, caller: row.caller,
        atMs: round(row.startEpochMs - startedEpochMs),
        durationMs: row.endEpochMs ? round(row.endEpochMs - row.startEpochMs) : null,
        complete: row.complete ?? false, status: row.status ?? null,
        encoding: row.encoding ?? null, contentLength: row.contentLength ?? null })),
      children: (data.children || []).map(row => ({ command: row.command, route: row.route,
        atMs: round(row.startEpochMs - startedEpochMs), spawnMs: round(row.spawnMs),
        lifetimeMs: row.endEpochMs ? round(row.endEpochMs - row.startEpochMs) : null,
        stack: row.stack.map(normalized) })),
      modules: data.modules.map(row => ({ owner: normalized(row.owner),
        inclusiveMs: round(row.inclusiveMs), exclusiveMs: round(row.exclusiveMs), calls: row.calls,
        atMs: round(row.firstEpochMs - startedEpochMs) })), cpu };
  });
}

export function launchStageIntervals(sample) {
  const server = sample.serverProfile?.find(row => row.role === 'http');
  const entry = server?.entryMs;
  const listen = server?.listeners[0]?.atMs;
  const firstByte = sample.documentStartMs + sample.navigation.responseStart;
  const paintEntry = sample.paints?.find(row => row.name === 'first-contentful-paint')
    ?? sample.paints?.find(row => row.name === 'first-paint');
  const paint = paintEntry ? sample.documentStartMs + paintEntry.atMs
    : sample.frame?.pageMs != null ? sample.documentStartMs + sample.frame.pageMs : null;
  return {
    renderedFrameMethod: paintEntry?.name ?? sample.frame?.method ?? null,
    processStartToServerEntryMs: entry ?? null,
    serverEntryToListenMs: listen != null && entry != null ? round(listen - entry) : null,
    listenToDocumentFirstByteMs: listen != null ? round(firstByte - listen) : null,
    firstByteToRenderedFrameMs: paint != null ? round(paint - firstByte) : null,
    renderedFrameToComposerMs: paint != null ? round(sample.interactiveComposerMs - paint) : null,
  };
}
