import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Reads the exempted red-file baseline for the integration gate (#2391).
 * Returns a Set of manifest paths, or null when the file is absent or
 * unreadable, which keeps the gate strict. With `ref`, the list is read as
 * committed at that commit instead of from the working tree.
 */
export function loadRedBaseline(path, ref, cwd = process.cwd()) {
  if (!path) return null;
  try {
    const text = ref ? committedText(ref, path, cwd) : existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.files)) return null;
    return new Set(parsed.files.map((entry) => entry?.path).filter((entry) => typeof entry === 'string'));
  } catch {
    return null;
  }
}

/** The list as committed at `ref`, so a change under test cannot add itself to it. */
function committedText(ref, path, cwd) {
  const result = spawnSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Splits per-file gate results against the baseline. A result is
 * `{ file, failed: boolean }`. Without a baseline every failure is new red.
 */
export function classifyAgainstBaseline(results, baseline) {
  const green = [];
  const baselineRed = [];
  const newRed = [];
  const nowGreen = [];
  for (const result of results) {
    const listed = baseline?.has(result.file) ?? false;
    if (result.failed) (listed ? baselineRed : newRed).push(result.file);
    else {
      green.push(result.file);
      if (listed) nowGreen.push(result.file);
    }
  }
  return { ran: results.length, green, baselineRed, newRed, nowGreen };
}
