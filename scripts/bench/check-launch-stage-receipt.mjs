import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkLaunchStageReceipt(result, args) {
  if (args['check-cli-startup']) {
    const count = result.samples.reduce((total, sample) => total + sample.serverProfile.flatMap(server => server.requests)
      .filter(row => row.route === '/api/setup/cli-updates' && row.atMs <= sample.interactiveComposerMs).length, 0);
    console.log(JSON.stringify({ check: 'startup-cli-discovery', count, limit: 0, passed: count === 0 }));
    assert.equal(count, 0, 'Launch must not enumerate tools before an explicit Tools action');
  }
  if (args.check) {
    console.log(JSON.stringify({ check: 'interactive-composer-ms', actual: result.maxMs, limit: 1000, passed: result.maxMs < 1000 }));
    assert(result.maxMs < 1000, `Launch budget exceeded: ${result.maxMs} ms >= 1000 ms`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = Object.fromEntries(process.argv.slice(3).map(arg => [arg.replace(/^--/, ''), true]));
  checkLaunchStageReceipt(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), flags);
}
