import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import type { OperatorDefaults, OperatorDefaultsWithSources } from '@/lib/operator/defaults';
import {
  parseOperatorDefaultsToml,
  serializeOperatorDefaultsToml,
  writeFileAtomic,
} from './toml';

const LEGACY_DEFAULTS_FILE = 'operator-defaults.json';
const SETTINGS_TOML_FILE = 'settings.toml';

type FileOperatorDefaults = Partial<OperatorDefaults> & {
  defaultDispatchRuntimeExplicit?: boolean;
};

export interface OperatorDefaultsTomlState {
  path: string;
  text: string;
  revision: string;
  error: string | null;
}

export class SettingsTomlConflictError extends Error {
  constructor() {
    super('settings.toml changed on disk — reload to see the current file');
    this.name = 'SettingsTomlConflictError';
  }
}

let writeQueue: Promise<void> = Promise.resolve();

export async function withOperatorDefaultsWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = writeQueue;
  let release!: () => void;
  writeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export async function withOperatorDefaultsUpdateRetry<T>(work: () => Promise<T>): Promise<T> {
  return withOperatorDefaultsWriteLock(async () => {
    let conflict: SettingsTomlConflictError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof SettingsTomlConflictError)) throw error;
        conflict = error;
      }
    }
    throw conflict ?? new SettingsTomlConflictError();
  });
}

function settingsTomlRevision(raw: string | undefined): string {
  return createHash('sha256')
    .update(raw === undefined ? 'missing\0' : `present\0${raw}`)
    .digest('hex');
}

export function getLegacyOperatorDefaultsPath(): string {
  return path.join(getDataDir(), LEGACY_DEFAULTS_FILE);
}

export function getOperatorDefaultsTomlPath(): string {
  return path.join(getDataDir(), SETTINGS_TOML_FILE);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function withExplicitRuntime(values: Partial<OperatorDefaults>): FileOperatorDefaults {
  return {
    ...values,
    defaultDispatchRuntimeExplicit: Object.prototype.hasOwnProperty.call(values, 'defaultDispatchRuntime'),
  };
}

export async function loadOperatorDefaultsFiles(
  parseLegacy: (raw: string) => FileOperatorDefaults,
): Promise<FileOperatorDefaults> {
  try {
    return withExplicitRuntime(parseOperatorDefaultsToml(await readFile(getOperatorDefaultsTomlPath(), 'utf8')));
  } catch (error) {
    if (!isMissingFile(error)) {
      // Parser errors can quote source lines containing saved credentials.
      console.error('[operator-defaults] Invalid settings.toml; using last-good defaults.');
    }
    try {
      return parseLegacy(await readFile(getLegacyOperatorDefaultsPath(), 'utf8'));
    } catch (fallbackError) {
      if (!isMissingFile(fallbackError)) {
        console.error('[operator-defaults] Failed to read last-good operator defaults.');
      }
      return {};
    }
  }
}

export function loadOperatorDefaultsFilesSync(
  parseLegacy: (raw: string) => FileOperatorDefaults,
): FileOperatorDefaults {
  try {
    return withExplicitRuntime(parseOperatorDefaultsToml(readFileSync(getOperatorDefaultsTomlPath(), 'utf8')));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Invalid settings.toml during sync read; using last-good defaults.');
    }
    try {
      return parseLegacy(readFileSync(getLegacyOperatorDefaultsPath(), 'utf8'));
    } catch (fallbackError) {
      if (!isMissingFile(fallbackError)) {
        console.error('[operator-defaults] Failed to read last-good operator defaults during sync read.');
      }
      return {};
    }
  }
}

export async function readOperatorDefaultsTomlForUpdate(): Promise<{
  raw: string | undefined;
  revision: string;
  values: Partial<OperatorDefaults>;
}> {
  try {
    const raw = await readFile(getOperatorDefaultsTomlPath(), 'utf8');
    return { raw, revision: settingsTomlRevision(raw), values: parseOperatorDefaultsToml(raw) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { raw: undefined, revision: settingsTomlRevision(undefined), values: {} };
  }
}

async function readCurrentSettingsToml(): Promise<string | undefined> {
  try {
    return await readFile(getOperatorDefaultsTomlPath(), 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return undefined;
  }
}

async function assertSettingsTomlRevision(expectedRevision: string): Promise<void> {
  const current = await readCurrentSettingsToml();
  if (settingsTomlRevision(current) !== expectedRevision) throw new SettingsTomlConflictError();
}

async function writeSettingsTomlAtRevision(content: string, expectedRevision: string): Promise<void> {
  await writeFileAtomic(
    getOperatorDefaultsTomlPath(),
    content,
    () => assertSettingsTomlRevision(expectedRevision),
  );
}

export async function readLegacyOperatorDefaults(): Promise<string | null> {
  try {
    return await readFile(getLegacyOperatorDefaultsPath(), 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Failed to read existing operator defaults.');
    }
    return null;
  }
}

export async function getOperatorDefaultsTomlState(
  projection: OperatorDefaults,
): Promise<OperatorDefaultsTomlState> {
  const filePath = getOperatorDefaultsTomlPath();
  let raw: string | null = null;
  try {
    raw = await readFile(filePath, 'utf8');
    parseOperatorDefaultsToml(raw);
    return { path: filePath, text: raw, revision: settingsTomlRevision(raw), error: null };
  } catch (error) {
    if (!isMissingFile(error)) {
      return {
        path: filePath,
        text: raw ?? '',
        revision: settingsTomlRevision(raw ?? undefined),
        error: error instanceof Error ? error.message : 'settings.toml is invalid.',
      };
    }
  }
  return {
    path: filePath,
    text: serializeOperatorDefaultsToml(projection),
    revision: settingsTomlRevision(undefined),
    error: null,
  };
}

export async function persistOperatorDefaults(
  values: OperatorDefaults,
  stored: object,
  existingToml?: string,
  expectedRevision?: string,
): Promise<void> {
  if (!expectedRevision) throw new Error('A settings.toml revision is required for field updates.');
  await writeSettingsTomlAtRevision(serializeOperatorDefaultsToml(values, existingToml), expectedRevision);
  await writeFileAtomic(getLegacyOperatorDefaultsPath(), `${JSON.stringify(stored, null, 2)}\n`);
}

export async function applyOperatorDefaultsTomlFile(
  raw: string,
  expectedRevision: string,
  fallback: OperatorDefaults,
  resolve: () => Promise<OperatorDefaultsWithSources>,
): Promise<OperatorDefaultsWithSources> {
  await assertSettingsTomlRevision(expectedRevision);
  const parsed = parseOperatorDefaultsToml(raw);
  const stored: Record<string, unknown> = { ...fallback, ...parsed };
  if (Object.prototype.hasOwnProperty.call(parsed, 'defaultDispatchRuntime')) {
    stored.defaultDispatchRuntimeExplicit = true;
  }
  await writeSettingsTomlAtRevision(raw.endsWith('\n') ? raw : `${raw}\n`, expectedRevision);
  await writeFileAtomic(getLegacyOperatorDefaultsPath(), `${JSON.stringify(stored, null, 2)}\n`);
  return resolve();
}

export async function applyOperatorDefaultsTomlWithLock(
  raw: string,
  expectedRevision: string,
  fallback: OperatorDefaults,
  resolve: () => Promise<OperatorDefaultsWithSources>,
): Promise<OperatorDefaultsWithSources> {
  return withOperatorDefaultsWriteLock(() => applyOperatorDefaultsTomlFile(raw, expectedRevision, fallback, resolve));
}
