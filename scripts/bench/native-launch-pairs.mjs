import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const root = path.resolve(args.output);
const wrapper = fileURLToPath(new URL('./native-launch-stages.mjs', import.meta.url));
const receipts = { main: [], head: [] };
for (let pair = 1; pair <= 3; pair++) {
  for (const variant of ['main', 'head']) {
    const output = path.join(root, `${variant}-${pair}`);
    execFileSync(process.execPath, [wrapper, `--harness=${args.harness}`, `--app=${args[variant]}`,
      `--sha=${args[`${variant}-sha`]}`, '--samples=1', `--output=${output}`,
      ...(variant === 'head' ? ['--check-cli-startup'] : [])], { stdio: 'inherit' });
    receipts[variant].push(JSON.parse(fs.readFileSync(path.join(output, 'stages.json'), 'utf8')));
  }
}
for (const variant of ['main', 'head']) {
  const runs = receipts[variant];
  assert.equal(new Set(runs.map(row => row.artifactDigest)).size, 1, 'Every pair must use the same exact app artifact');
  assert(runs.every(row => row.teardownVerified && !row.cpuProfiled));
  const samples = runs.flatMap((row, index) => row.samples.map(sample => ({ ...sample, sample: index + 1, pair: index + 1 })));
  const ordered = samples.map(row => row.interactiveComposerMs).sort((a, b) => a - b);
  const result = { ...runs[0], samples, medianMs: ordered[1], maxMs: ordered.at(-1),
    pairOrder: 'main/head repeated three times; fresh app data and staged copy for every launch' };
  const directory = path.join(root, variant);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'stages.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ timingSummary: variant, samplesMs: samples.map(row => row.interactiveComposerMs),
    medianMs: result.medianMs, maxMs: result.maxMs, pairOrder: result.pairOrder }));
}
