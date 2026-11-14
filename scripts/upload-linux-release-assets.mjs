#!/usr/bin/env node
/** Attach a digest-bound pair with ownership-labelled rollback of partial uploads. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function main() {
  const tag = process.env.RELEASE_TAG;
  const repo = process.env.GH_REPO;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid release identity');
  const name = `o8-${tag.slice(1)}-x86_64.AppImage`;
  const names = [name, `${name}.sig`];
  if (readdirSync('publish').sort().join('\n') !== [...names].sort().join('\n')) throw new Error('Expected exactly the verified AppImage and signature');
  for (const [index, file] of names.entries()) {
    const expected = [process.env.APPIMAGE_SHA256, process.env.SIGNATURE_SHA256][index];
    const path = join('publish', file);
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Invalid verified SHA-256 output');
    if (!lstatSync(path).isFile() || !lstatSync(path).size) throw new Error('Invalid release asset');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error('Verified asset digest mismatch');
  }
  // Bound upload to 30 minutes plus five for cleanup/label clearing.
  // The 60-minute job leaves 25 minutes for setup, download and runner overhead.
  const deadline = Date.now() + 30 * 60 * 1000;
  const cleanupDeadline = deadline + 5 * 60 * 1000;
  const gh = (args, cleanup = false) => {
    const remaining = (cleanup ? cleanupDeadline : deadline) - Date.now();
    if (remaining <= 0) throw new Error('Release upload internal deadline exceeded');
    return execFileSync('gh', args, { encoding: 'utf8', timeout: Math.min(remaining, cleanup ? 60000 : remaining), killSignal: 'SIGKILL' });
  };
  const assets = (cleanup = false) => JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`], cleanup)).assets;
  const owned = asset => names.includes(asset.name) && /^o8-linux-upload-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(asset.label ?? '');
  const remove = list => {
    const errors = [];
    for (const asset of list) {
      try { gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`], true); }
      catch (error) { errors.push(error.message); }
    }
    return errors;
  };
  const complete = (list, label) => names.every((file, index) => list.some(asset =>
    asset.name === file && asset.label === label && asset.state === 'uploaded'
    && asset.size === lstatSync(join('publish', file)).size
    && (asset.digest == null || asset.digest === `sha256:${[process.env.APPIMAGE_SHA256, process.env.SIGNATURE_SHA256][index]}`)));
  let before = assets();
  const targets = before.filter(asset => names.includes(asset.name));
  if (targets.length) {
    const previousLabel = targets[0].label;
    // Refuse the entire inventory before any mutation, including a completed
    // pair whose signature was subsequently replaced by another publisher.
    if (!targets.every(asset => owned(asset) && asset.label === previousLabel)
      || complete(targets, previousLabel)) throw new Error('Release asset already exists; refusing replacement');
    const recoveryErrors = remove(targets);
    if (recoveryErrors.length) throw new Error(`Leftover cleanup failed: ${recoveryErrors.join('; ')}`);
    before = assets();
    if (before.some(asset => names.includes(asset.name))) throw new Error('Release asset already exists after cleanup');
  }
  const beforeIds = new Set(before.map(asset => asset.id));
  const label = `o8-linux-upload-${randomUUID()}`;
  let observed = [];
  try {
    gh(['release', 'upload', tag, '--repo', repo, ...names.map(file => `${join('publish', file)}#${label}`)]);
    observed = assets();
    if (!complete(observed, label)) throw new Error('Release upload pair was incomplete');
  } catch (error) {
    const errors = [];
    // Retry listing independently; a failed inventory must not suppress deletes
    // of assets already observed, nor a later successful inventory.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { observed = assets(true); break; } catch (listingError) { errors.push(listingError.message); }
    }
    errors.push(...remove(observed.filter(asset => owned(asset) && asset.label === label && !beforeIds.has(asset.id))));
    throw new Error([error.message, ...errors].join('; '));
  }
  // A verified pair is committed. Label clearing is a separate, non-destructive
  // phase: errors here must never roll back assets that clients may now use.
  const clearErrors = [];
  for (const asset of observed.filter(asset => names.includes(asset.name) && asset.label === label)) {
    try { gh(['api', '--method', 'PATCH', `repos/${repo}/releases/assets/${asset.id}`, '-f', 'label='], true); }
    catch (error) { clearErrors.push(error.message); }
  }
  try {
    const final = assets(true);
    if (!names.every(file => final.some(asset => asset.name === file && !asset.label))) clearErrors.push('Final asset labels are not empty');
  } catch (error) { clearErrors.push(error.message); }
  if (clearErrors.length) throw new Error(`Uploaded pair retained; label clearing failed: ${clearErrors.join('; ')}`);
}
try { main(); } catch (error) { console.error(`Linux attachment failed: ${error.message}`); process.exitCode = 1; }
