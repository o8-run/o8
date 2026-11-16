/**
 * After a stable release publishes, ask the Homebrew tap to move its cask to
 * that version. The tap's own workflow downloads the installer, hashes it and
 * commits the change, so this only dispatches it. Best effort: a failure here
 * never fails a release, and the tap checks for a new release once a day.
 */

import { execFileSync } from 'node:child_process';

export const HOMEBREW_TAP = 'o8-run/homebrew-tap';
const STABLE = /^\d+\.\d+\.\d+$/;

export function requestHomebrewBump(version, exec = execFileSync) {
  if (!STABLE.test(version)) return { requested: false, reason: `${version} is not a stable version` };
  try {
    exec('gh', ['workflow', 'run', 'bump.yml', '-R', HOMEBREW_TAP, '-f', `version=${version}`], { stdio: 'pipe' });
    return { requested: true, reason: null };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0] || 'gh failed';
    return { requested: false, reason: detail };
  }
}
