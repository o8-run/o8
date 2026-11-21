import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type RemoteRuntimeFlagSource = 'env' | 'file' | 'off';

export interface RemoteRuntimeFlagState {
  enabled: boolean;
  source: RemoteRuntimeFlagSource;
}

const FEATURE_FLAGS_FILE = 'feature-flags.json';

function getFeatureFlagsPath() {
  return path.join(
    getDataDir(),
    FEATURE_FLAGS_FILE,
  );
}

function getEnvRemoteRuntimeFlag(): RemoteRuntimeFlagState | null {
  if (process.env.O8_ENABLE_REMOTE_RUNTIME === '1') {
    return { enabled: true, source: 'env' };
  }
  return null;
}

function readRemoteRuntimeFlag(raw: string): RemoteRuntimeFlagState | null {
  const parsed = JSON.parse(raw) as { remoteRuntime?: unknown };
  if (typeof parsed.remoteRuntime === 'boolean') {
    return { enabled: parsed.remoteRuntime, source: 'file' };
  }
  return null;
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function getRemoteRuntimeFlagSync(): RemoteRuntimeFlagState {
  const envFlag = getEnvRemoteRuntimeFlag();
  if (envFlag) return envFlag;

  try {
    const raw = readFileSync(getFeatureFlagsPath(), 'utf8');
    const fileFlag = readRemoteRuntimeFlag(raw);
    if (fileFlag) return fileFlag;
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[worker-flags] Failed to read feature flags during startup:', error);
    }
  }

  return { enabled: false, source: 'off' };
}
