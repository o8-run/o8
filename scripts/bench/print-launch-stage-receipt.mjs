import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep individual lines bounded and flush them before a failing budget assertion.
export async function printLaunchStageReceipt(receipt) {
  const write = value => new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
  });
  await write({ schema: receipt.schema, sourceSha: receipt.sourceSha, medianMs: receipt.medianMs,
    maxMs: receipt.maxMs, teardownVerified: receipt.teardownVerified, cpuProfiled: receipt.cpuProfiled });
  for (const sample of receipt.samples) {
    const { serverProfile, resources, clientModules, frameCallbacks, ...stages } = sample;
    await write({ stages });
    for (const server of serverProfile || []) {
      await write({ sample: sample.sample, server: server.role, entryMs: server.entryMs, listeners: server.listeners,
        modules: server.modules.slice(0, 12), cpu: server.cpu });
      await write({ sample: sample.sample, server: server.role, requests: server.requests });
      await write({ sample: sample.sample, server: server.role,
        children: (server.children || []).sort((a, b) => b.spawnMs - a.spawnMs).slice(0, 30) });
    }
    await write({ sample: sample.sample, resources, clientModules, frameCallbacks });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await printLaunchStageReceipt(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
}
