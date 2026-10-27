/**
 * `o8 version` — CLI version + connected server version.
 *
 * The CLI version is injected at build time from the repo-root package.json
 * (the app version, kept in sync by scripts/sync-version.mjs) via an esbuild
 * `--define` in cli/esbuild.config.mjs, so the bundled `o8` binary always
 * reports the version it shipped with. The server version is whatever
 * `/api/panel/status` returns.
 */

import { apiFetch, type CliError } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';

// Replaced by esbuild --define at build time (cli/esbuild.config.mjs). Falls
// back to a dev marker when run unbundled (e.g. via tsx during development).
declare const __O8_CLI_VERSION__: string | undefined;
export const CLI_VERSION = typeof __O8_CLI_VERSION__ !== 'undefined' ? __O8_CLI_VERSION__ : '0.0.0-dev';

interface PanelStatus {
  version: string | null;
  nodeVersion?: string;
  platform?: string;
  mode?: string;
  runtime?: string;
}

export async function runVersion(mode: OutputMode, offline = false): Promise<number> {
  if (offline) {
    if (mode.human) printHumanKv([['cli', CLI_VERSION]]);
    else printJson({ schema: 'o8/cli/version/v1', cliVersion: CLI_VERSION });
    return 0;
  }
  const cfg = resolveConfig();
  let serverVersion: string | null = null;
  let nodeVersion: string | undefined;
  let serverReachable = false;
  try {
    const res = await apiFetch<PanelStatus>(cfg, '/api/panel/status');
    if (res.data) {
      serverVersion = res.data.version ?? null;
      nodeVersion = res.data.nodeVersion;
      serverReachable = true;
    }
  } catch (err) {
    // Don't fail `version` on a missing server — agents call `version` to
    // probe the install before deciding whether to call other commands.
    const code = (err as CliError).code;
    if (code !== 'connection_refused' && code !== 'unauthorized') throw err;
  }

  const payload = {
    schema: 'o8/cli/version/v1',
    cliVersion: CLI_VERSION,
    serverVersion,
    serverReachable,
    nodeVersion: nodeVersion ?? null,
    apiBase: cfg.apiBase,
  };

  if (mode.human) {
    printHumanKv([
      ['cli', CLI_VERSION],
      ['server', serverVersion ?? '(unknown)'],
      ['reachable', serverReachable ? 'yes' : 'no'],
      ['api', cfg.apiBase],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
