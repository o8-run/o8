import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEV_API_PORT_BLOCK } from '@/lib/panel/port-constants';
import {
  loadWorkspaceManifest,
  migrateManifest,
  parseWorkspaceManifest,
  type WorkspaceManifestV1,
} from './index';

const validManifest: WorkspaceManifestV1 = {
  version: 1,
  setup: ['npm install', 'npm run build'],
  teardown: ['npm run cleanup'],
  services: [
    {
      name: 'api',
      command: 'npm run dev:api',
      cwd: 'apps/api',
      env: { LOG_LEVEL: 'debug' },
      port: { preferred: 4100, env: 'PORT' },
      health: { http: 'http://127.0.0.1:4100/health', timeoutMs: 30_000 },
    },
    {
      name: 'web',
      command: 'npm run dev:web',
      port: { preferred: 4173 },
      health: { tcp: true },
    },
  ],
  preview: { url: 'http://127.0.0.1:{{service:web}}' },
};

describe('workspace manifest v1', () => {
  it('round-trips a valid v1 record', () => {
    const serialized = JSON.stringify(validManifest);
    const parsed = parseWorkspaceManifest(JSON.parse(serialized));

    expect(parsed).toEqual(validManifest);
    expect(JSON.stringify(parsed)).toBe(serialized);
  });

  it('rejects an unknown key with its JSON path', () => {
    expect(() => parseWorkspaceManifest({
      version: 1,
      services: [{ name: 'api', command: 'npm run api', restartPolicy: 'always' }],
    })).toThrow('$.services[0].restartPolicy: unknown key');
  });

  it('rejects a preferred port reserved by o8', () => {
    expect(() => parseWorkspaceManifest({
      version: 1,
      services: [{
        name: 'api',
        command: 'npm run api',
        port: { preferred: DEV_API_PORT_BLOCK[0] },
      }],
    })).toThrow(`$.services[0].port.preferred: port ${DEV_API_PORT_BLOCK[0]} is reserved by o8`);
  });

  it('rejects duplicate service names', () => {
    expect(() => parseWorkspaceManifest({
      version: 1,
      services: [
        { name: 'api', command: 'npm run api' },
        { name: 'api', command: 'npm run api:second' },
      ],
    })).toThrow('$.services[1].name: duplicate service name "api"');
  });

  it('returns null when the repository has no manifest file', async () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-manifest-missing-'));
    try {
      await expect(loadWorkspaceManifest(repoPath)).resolves.toBeNull();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('keeps v1 as an identity migration and rejects unsupported versions', () => {
    expect(migrateManifest(validManifest)).toBe(validManifest);
    expect(() => migrateManifest({ version: 0 })).toThrow(
      '$.version: unsupported workspace manifest version 0; expected 1',
    );
  });
});
