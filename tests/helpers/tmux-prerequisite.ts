import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One explanation per test run, including when suites run in separate workers. */
export function tmuxIntegrationAvailable(): boolean {
  if (process.platform !== 'win32') {
    try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { /* unavailable */ }
  }
  const runRoot = process.env.O8_TEST_RUN_DATA_ROOT;
  if (runRoot) {
    try { writeFileSync(join(runRoot, '.tmux-skip-reported'), '', { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    }
  }
  // Console capture may be discarded when a file is wholly skipped.
  process.stderr.write('[tmux-integration] Skipping real tmux tests: tmux is unavailable or this platform is unsupported.\n');
  return false;
}
