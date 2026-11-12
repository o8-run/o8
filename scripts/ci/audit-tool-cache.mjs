#!/usr/bin/env node
// Cache the executable, never advisory databases or audit results. Resolve the
// stable release on every run so a warm cache cannot pin an older scanner.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const toolchain = process.argv[2];
if (!toolchain?.trim() || !process.env.GITHUB_OUTPUT) throw new Error('Toolchain identity and GITHUB_OUTPUT are required');
const response = await fetch(process.env.AUDIT_TOOL_REGISTRY_URL ?? 'https://crates.io/api/v1/crates/cargo-audit', {
  headers: { 'User-Agent': 'o8-ci-audit-tool-cache' }, signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Scanner version registry returned ${response.status}`);
const metadata = await response.json();
const version = metadata?.crate?.max_stable_version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Registry returned no stable scanner version');
const release = Array.isArray(metadata?.versions)
  ? metadata.versions.find(entry => entry?.num === version && entry?.yanked === false) : undefined;
const source = release?.checksum;
if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source)) throw new Error('Registry returned no stable scanner source checksum');
const identity = createHash('sha256').update(toolchain).digest('hex');
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nsource=${source}\ntoolchain=${identity}\n`);
