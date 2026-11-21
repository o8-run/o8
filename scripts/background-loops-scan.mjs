#!/usr/bin/env node
// Lists server timers that are not registered with the background-work ledger
// (src/lib/background-work/ledger.ts), so the unregistered count is known.
// Usage: node scripts/background-loops-scan.mjs [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skipDirs = new Set(['node_modules', 'components', 'hooks', '__tests__', 'vendor']);
// Browser-side timers that only share a lib folder with server code.
const clientFiles = new Set(['src/lib/github-broker/refresh-schedule.ts', 'src/lib/presentation/quiet-mode-client.ts']);

function* serverFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!skipDirs.has(name)) yield* serverFiles(path);
    } else if (/\.(ts|mts|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) {
      yield path;
    }
  }
}

export function scanBackgroundLoops() {
  const registered = new Set();
  const unregistered = [];
  for (const file of serverFiles(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    if (/^['"]use client['"]/m.test(text)) continue;
    const rel = relative(root, file);
    if (clientFiles.has(rel)) continue;
    for (const match of text.matchAll(/(?:recurring|trackRun|gatedRun)\('([^']+)'/g)) registered.add(match[1]);
    text.split('\n').forEach((line, index) => {
      if (/\bsetInterval\(/.test(line) && !rel.startsWith('src/lib/background-work/')) {
        unregistered.push({ file: rel, line: index + 1, text: line.trim().slice(0, 120) });
      }
    });
  }
  return { registered: [...registered].sort(), unregistered };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = scanBackgroundLoops();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Registered loops: ${result.registered.length}`);
    console.log(`Unregistered setInterval sites: ${result.unregistered.length}`);
    for (const site of result.unregistered) console.log(`  ${site.file}:${site.line}  ${site.text}`);
  }
}
