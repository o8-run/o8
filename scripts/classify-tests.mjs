#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestClassificationReport } from './lib/test-classification.mjs';
import { auditDatedFixtures } from './lib/dated-fixtures.mjs';
import { probeDatedFixtures } from './lib/dated-fixture-probe.mjs';

const root = process.cwd();
const manifestPath = join(root, 'tests/test-classification.json');
const classification = buildTestClassificationReport(root);
const next = `${JSON.stringify(classification.manifest, null, 2)}\n`;
const mode = process.argv[2] || '--check';

const dated = auditDatedFixtures(root, classification.hermeticFiles);
for (const warning of dated.warnings) console.warn(`[dated-fixtures] WARNING ${warning}`);
const errors = probeDatedFixtures(root, dated.probes);
for (const error of errors) console.error(`[dated-fixtures] ${error}`);
if (errors.length) process.exit(1);

if (mode === '--write') {
  writeFileSync(manifestPath, next);
  console.log(`[test-classification] ${classification.hermeticTests} hermetic, ${classification.resourceOwningTests} resource-owning`);
  process.exit(0);
}
if (mode !== '--check') {
  console.error('usage: node scripts/classify-tests.mjs --check|--write');
  process.exit(1);
}
const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
if (current !== next) {
  console.error('[test-classification] manifest drifted; run npm run test:classify');
  process.exit(1);
}
console.log('[test-classification] manifest matches resource-owning source markers');
